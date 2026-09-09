import { InstanceTracker } from './instance_tracker';
import { Context } from './context';
import ShutdownManager from './shutdown_manager';
import Audit from './audit';
import { CloudInstanceManagerSelector, CloudInstanceManagerSelectorOptions } from './cloud_instance_manager_selector';
import { InstanceGroup, InstanceDetails, InstanceState } from './instance_store';

export interface CloudRetryStrategy {
    maxTimeInSeconds: number;
    maxDelayInSeconds: number;
    retryableStatusCodes: number[];
}

export interface CloudManagerOptions extends CloudInstanceManagerSelectorOptions {
    shutdownManager: ShutdownManager;
    instanceTracker: InstanceTracker;
    audit: Audit;
    cloudInstanceManagerSelector?: CloudInstanceManagerSelector;
}

export interface CloudInstance {
    instanceId: string;
    displayName: string;
    cloudStatus: string;
}

export default class CloudManager {
    private instanceTracker: InstanceTracker;
    private cloudInstanceManagerSelector: CloudInstanceManagerSelector;

    private shutdownManager: ShutdownManager;
    private audit: Audit;
    private isDryRun: boolean;

    constructor(options: CloudManagerOptions) {
        this.isDryRun = options.isDryRun;

        if (options.cloudInstanceManagerSelector) {
            this.cloudInstanceManagerSelector = options.cloudInstanceManagerSelector;
        } else {
            this.cloudInstanceManagerSelector = new CloudInstanceManagerSelector(options);
        }

        this.instanceTracker = options.instanceTracker;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;
    }

    async recordLaunch(
        ctx: Context,
        group: InstanceGroup,
        instanceId: string | boolean,
        isScaleDownProtected: boolean,
    ): Promise<void> {
        if (instanceId) {
            if (!this.isDryRun && instanceId !== true) {
                await this.audit.saveLaunchEvent(group.name, instanceId);
                const state: InstanceState = {
                    instanceId: instanceId,
                    instanceType: group.type,
                    status: {
                        provisioning: true,
                    },
                    timestamp: Date.now(),
                    metadata: { group: group.name },
                };
                await this.instanceTracker.track(ctx, state);
                if (isScaleDownProtected) {
                    await this.shutdownManager.setScaleDownProtected(
                        ctx,
                        group.name,
                        instanceId,
                        group.protectedTTLSec,
                    );
                    ctx.logger.info(
                        `[CloudManager] Instance ${instanceId} from group ${group.name} is in protected mode`,
                    );
                }
            }
        } else {
            ctx.logger.warn(`[CloudManager] Instance launch failed, instance not recorded from group ${group.name}`);
        }
    }

    async scaleUp(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
        isScaleDownProtected: boolean,
    ): Promise<number> {
        const groupName = group.name;
        ctx.logger.info('[CloudManager] Scaling up', { scaleUp: { groupName, quantity, isScaleDownProtected } });

        const instanceManager = this.cloudInstanceManagerSelector.selectInstanceManager(group.cloud);
        if (!instanceManager) {
            ctx.logger.error(`Cloud type not configured: ${group.cloud}`);
            return 0;
        }

        // instance managers are expected to resolve with one entry per requested instance
        // (id, true for dry run, or false), but a rejection must not take the whole scale up
        // down with it: log and report zero launches recorded.
        let scaleUpResult: Array<string | boolean>;
        try {
            scaleUpResult = await instanceManager.launchInstances(ctx, group, groupCurrentCount, quantity);
        } catch (err) {
            ctx.logger.error(
                `[CloudManager] Launching instances for group ${groupName} failed unexpectedly, no launches recorded: ${err}`,
                { err, groupName, quantity },
            );
            return 0;
        }
        const launched = Array.isArray(scaleUpResult) ? scaleUpResult : [];

        // record every launched id, even when sibling entries failed or recording one of them fails
        let scaleUpCount = 0;
        const recordOutcomes = await Promise.allSettled(
            launched.map(async (instanceId) => {
                if (instanceId) {
                    scaleUpCount++;
                }
                await this.recordLaunch(ctx, group, instanceId, isScaleDownProtected);
            }),
        );
        recordOutcomes.forEach((outcome, i) => {
            if (outcome.status === 'rejected') {
                ctx.logger.error(
                    `[CloudManager] Failed recording launch of instance ${launched[i]} in group ${groupName}; the instance was launched but is untracked until the sanity loop finds it: ${outcome.reason}`,
                    { err: outcome.reason, instanceId: launched[i], groupName },
                );
            }
        });

        return scaleUpCount;
    }

    /**
     * Requests shutdown of the given instances by flagging them for their sidecars. No cloud
     * provider API is called here, by any provider: the sidecar polling each instance picks up
     * the shutdown status and terminates its own VM/job. Consequently an instance whose sidecar
     * is not running or not polling is never reaped by the autoscaler; it keeps showing up in
     * the cloud provider listing until it is removed by other means.
     */
    async scaleDown(ctx: Context, group: InstanceGroup, instances: InstanceDetails[]): Promise<boolean> {
        const groupName = group.name;
        ctx.logger.info('[CloudManager] Requesting shutdown via sidecar', { groupName, instances });
        await this.shutdownManager.setShutdownStatus(ctx, instances);
        ctx.logger.info(
            `[CloudManager] Shutdown requested via sidecar for ${instances.length} instances in group ${groupName}; termination is performed by the sidecar`,
        );
        return true;
    }

    /**
     * Confirms shutdown of a single instance to its sidecar. As with scaleDown, the
     * termination itself is performed by the sidecar, not by a cloud provider API call.
     */
    async shutdownInstance(ctx: Context, instance: InstanceDetails): Promise<boolean> {
        const groupName = instance.group;
        ctx.logger.info(
            `[CloudManager] Shutdown confirmed via sidecar for instance ${instance.instanceId} from group ${groupName}; termination is performed by the sidecar`,
        );
        await this.shutdownManager.setShutdownConfirmation(ctx, [instance]);
        return true;
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<CloudInstance[]> {
        const instanceManager = this.cloudInstanceManagerSelector.selectInstanceManager(group.cloud);
        if (!instanceManager) {
            ctx.logger.error(`Cloud type not configured: ${group.cloud}`);
            return [];
        }

        const instances = await instanceManager.getInstances(ctx, group, cloudRetryStrategy);
        return instances.filter(function (instance) {
            return instance.cloudStatus && instance.cloudStatus.toUpperCase() !== 'TERMINATED';
        });
    }
}
