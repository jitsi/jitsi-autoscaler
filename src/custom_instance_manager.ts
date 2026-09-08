import { execFile } from 'child_process';
import { Context } from './context';
import { AbstractCloudInstanceManager, CloudInstance } from './cloud_instance_manager';
import { CloudRetryStrategy } from './cloud_manager';
import { InstanceGroup } from './instance_store';

/**
 * Custom provider script contract
 *
 * Both scripts are executed with execFile (no shell) and killed after
 * CUSTOM_CONFIGURATION_LAUNCH_SCRIPT_TIMEOUT_MS. Each flag and its value are passed as a
 * SINGLE argv element, e.g. argv[1] is the string "--type jibri" (historical behaviour of
 * the launch script, kept for compatibility); scripts must split on the first space.
 *
 * Launch script (CUSTOM_CONFIGURATION_LAUNCH_SCRIPT_FILE_PATH), run once per instance:
 *
 *     <script> "--type <type>" "--name <displayName>" "--groupName <groupName>" "--region <region>"
 *
 *   Exit 0 and print the id of the new cloud instance as the LAST non-empty line of stdout.
 *   Any other output must precede it (or go to stderr). Exit 0 with nothing on stdout is
 *   treated as a failed launch and logged distinctly, because a VM may have been created
 *   that the autoscaler can not track. A non-zero exit or a timeout kill is a failed launch;
 *   after a timeout kill the same orphan warning is logged.
 *
 * List script (CUSTOM_CONFIGURATION_LIST_SCRIPT_FILE_PATH, optional), run by the sanity
 * loop and reports to reconcile tracked instances against the provider:
 *
 *     <script> "--groupName <groupName>"
 *
 *   Exit 0 and print exactly one JSON array on stdout (nothing else on stdout):
 *
 *     [{ "instanceId": "i-123", "displayName": "group-abcde", "cloudStatus": "RUNNING" }, ...]
 *
 *   instanceId and cloudStatus are required strings, displayName is optional (defaults to
 *   instanceId). cloudStatus is compared case-insensitively: PROVISIONING and RUNNING count
 *   as alive, TERMINATED and SHUTDOWN are ignored, anything else is reported as-is. Malformed
 *   output, a non-zero exit or a timeout is logged as a warning and treated as "no instances".
 *   When the variable is unset, getInstances() returns [] and no reconciliation happens for
 *   custom groups (instances without a working sidecar are then never noticed).
 */
export interface CustomInstanceManagerOptions {
    isDryRun: boolean;
    customConfigurationLaunchScriptPath: string;
    customConfigurationLaunchScriptTimeoutMs: number;
    customConfigurationListScriptPath?: string;
}

const NO_INSTANCE_ID_MESSAGE = 'script produced no instance id; a VM may have been created but cannot be tracked';
// stdout limit for the list script, well above the default 1MB of execFile
const LIST_SCRIPT_MAX_BUFFER = 16 * 1024 * 1024;

interface ScriptError extends Error {
    killed?: boolean;
    signal?: string;
    code?: number | string;
}

/**
 * Validate the list script output into CloudInstance[]; throws on any shape violation.
 */
function parseCloudInstances(raw: string): CloudInstance[] {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('expected a JSON array of instances');
    }
    return parsed.map((item: unknown, i: number): CloudInstance => {
        if (!item || typeof item !== 'object') {
            throw new Error(`item ${i} is not an object`);
        }
        const { instanceId, displayName, cloudStatus } = item as Record<string, unknown>;
        if (typeof instanceId !== 'string' || !instanceId) {
            throw new Error(`item ${i} is missing a string instanceId`);
        }
        if (typeof cloudStatus !== 'string' || !cloudStatus) {
            throw new Error(`item ${i} (${instanceId}) is missing a string cloudStatus`);
        }
        if (displayName !== undefined && typeof displayName !== 'string') {
            throw new Error(`item ${i} (${instanceId}) has a non-string displayName`);
        }
        return { instanceId, displayName: typeof displayName === 'string' ? displayName : instanceId, cloudStatus };
    });
}

export default class CustomInstanceManager extends AbstractCloudInstanceManager {
    private isDryRun: boolean;
    private customConfigurationLaunchScriptPath: string;
    private customConfigurationLaunchScriptTimeoutMs: number;
    private customConfigurationListScriptPath: string;

    constructor(options: CustomInstanceManagerOptions) {
        super();
        this.isDryRun = options.isDryRun;
        this.customConfigurationLaunchScriptPath = options.customConfigurationLaunchScriptPath;
        this.customConfigurationLaunchScriptTimeoutMs = options.customConfigurationLaunchScriptTimeoutMs;
        this.customConfigurationListScriptPath = options.customConfigurationListScriptPath || '';

        this.launchInstances = this.launchInstances.bind(this);
        this.execLaunch = this.execLaunch.bind(this);
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[custom] Launching a batch of ${quantity} instances in group ${group.name}`);

        const indexes = <number[]>[];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        const result = await Promise.all(
            indexes.map(async (index) => {
                return this.launchInstance(ctx, index, group);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);

        return result;
    }

    async launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

        const displayName = groupName + '-' + AbstractCloudInstanceManager.makeRandomString(5);

        ctx.logger.info(`[custom] Launching instance number ${index + 1} in group ${groupName} with properties`, {
            groupName,
            displayName,
            groupInstanceConfigurationId,
        });

        if (this.isDryRun) {
            ctx.logger.info(`[custom] Dry run enabled, skipping the instance number ${index + 1} launch`);
            return true;
        }
        try {
            const launchResponse = await this.execLaunch({
                ctx,
                displayName,
                groupName,
                region: group.region,
                type: group.type,
            });
            if (launchResponse === false) {
                // already logged by execLaunch
                return false;
            }
            ctx.logger.info(
                `[custom] Got launch response for instance number ${
                    index + 1
                } in group ${groupName}: ${launchResponse}`,
            );

            return launchResponse;
        } catch (err) {
            ctx.logger.error(
                `[custom] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
                { err },
            );
            return false;
        }
    }

    /**
     * Runs the launch script. Resolves with the instance id, or `false` when the script
     * exited 0 without printing one; rejects when the script fails or is killed.
     */
    async execLaunch({
        ctx,
        displayName,
        groupName,
        region,
        type,
    }: {
        ctx: Context;
        displayName: string;
        groupName: string;
        region: string;
        type: string;
    }): Promise<string | false> {
        const describe = `type ${type}, name ${displayName}, groupName ${groupName} and region ${region}`;
        let stdout: string;
        try {
            stdout = await this.execScript(this.customConfigurationLaunchScriptPath, [
                `--type ${type}`,
                `--name ${displayName}`,
                `--groupName ${groupName}`,
                `--region ${region}`,
            ]);
        } catch (error) {
            const scriptError = <ScriptError>error;
            if (scriptError.killed) {
                ctx.logger.error(
                    `[custom] Launch script for ${describe} was killed after ${this.customConfigurationLaunchScriptTimeoutMs}ms (signal ${scriptError.signal}); ${NO_INSTANCE_ID_MESSAGE}`,
                    { error, displayName, groupName },
                );
            } else {
                ctx.logger.error(`[custom] Failed executing launch file for ${describe} with error: ${error}`, {
                    error,
                });
            }
            throw error;
        }

        const instanceId = (stdout || '').trim().split('\n').pop().trim();
        if (!instanceId) {
            ctx.logger.error(`[custom] Launch script for ${describe} exited 0 but ${NO_INSTANCE_ID_MESSAGE}`, {
                displayName,
                groupName,
                stdout,
            });
            return false;
        }
        return instanceId;
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        _cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<CloudInstance[]> {
        if (!this.customConfigurationListScriptPath) {
            ctx.logger.debug(
                `[custom] No list script configured (CUSTOM_CONFIGURATION_LIST_SCRIPT_FILE_PATH), reporting no cloud instances for group ${group.name}`,
            );
            return [];
        }
        try {
            const stdout = await this.execScript(
                this.customConfigurationListScriptPath,
                [`--groupName ${group.name}`],
                LIST_SCRIPT_MAX_BUFFER,
            );
            const instances = parseCloudInstances((stdout || '').trim() || '[]');
            ctx.logger.debug(`[custom] List script reported ${instances.length} instances for group ${group.name}`, {
                instances,
            });
            return instances;
        } catch (err) {
            ctx.logger.warn(
                `[custom] Failed listing instances for group ${group.name} with ${this.customConfigurationListScriptPath}, treating as no cloud instances: ${err}`,
                { err },
            );
            return [];
        }
    }

    private execScript(scriptPath: string, args: string[], maxBuffer?: number): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                scriptPath,
                args,
                { timeout: this.customConfigurationLaunchScriptTimeoutMs, maxBuffer },
                (error, stdout) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(stdout);
                },
            );
        });
    }
}
