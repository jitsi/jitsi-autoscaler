import { execFile } from 'child_process';
import { Context } from './context';
import { AbstractCloudInstanceManager } from './cloud_instance_manager';
import { InstanceGroup } from './instance_store';

export interface CustomInstanceManagerOptions {
    isDryRun: boolean;
    customConfigurationLaunchScriptPath: string;
    customConfigurationLaunchScriptTimeoutMs: number;
}

export default class CustomInstanceManager extends AbstractCloudInstanceManager {
    private isDryRun: boolean;
    private customConfigurationLaunchScriptPath: string;
    private customConfigurationLaunchScriptTimeoutMs: number;

    constructor(options: CustomInstanceManagerOptions) {
        super();
        this.isDryRun = options.isDryRun;
        this.customConfigurationLaunchScriptPath = options.customConfigurationLaunchScriptPath;
        this.customConfigurationLaunchScriptTimeoutMs = options.customConfigurationLaunchScriptTimeoutMs;

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

        const indexes: Array<number> = [];
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

    execLaunch({
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
    }): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                this.customConfigurationLaunchScriptPath,
                [`--type ${type}`, `--name ${displayName}`, `--groupName ${groupName}`, `--region ${region}`],
                { timeout: this.customConfigurationLaunchScriptTimeoutMs },
                (error, stdout) => {
                    if (error) {
                        ctx.logger.error(
                            `[custom] Failed executing launch file for type ${type}, name ${displayName},  groupName ${groupName} and region ${region} with error: ${error}`,
                            { error },
                        );
                        reject(error);
                        return;
                    }

                    const instanceId = stdout.trim().split('\n').pop();
                    resolve(instanceId);
                },
            );
        });
    }
}
