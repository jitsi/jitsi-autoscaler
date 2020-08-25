import { JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import Redis from 'ioredis';
import Redlock from 'redlock';
import LockManager from './lock_manager';
import { Context } from './context';
import * as promClient from 'prom-client';
import ShutdownManager from './shutdown_manager';

const instancesCount = new promClient.Gauge({
    name: 'autoscaling_instance_count',
    help: 'Gauge for current instances',
    labelNames: ['group'],
});

const instancesLaunched = new promClient.Gauge({
    name: 'autoscaling_instance_launched',
    help: 'Gauge for launched instances',
    labelNames: ['group'],
});

const instancesDownscaled = new promClient.Gauge({
    name: 'autoscaling_instance_downscaled',
    help: 'Gauge for scaled down instances',
    labelNames: ['group'],
});

const instanceErrors = new promClient.Gauge({
    name: 'autoscaling_instance_errors',
    help: 'Gauge for instance errors',
    labelNames: ['group'],
});

export interface InstanceLauncherOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
    shutdownManager: ShutdownManager;
}

export default class InstanceLauncher {
    private jibriTracker: JibriTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;
    private shutdownManager: ShutdownManager;

    constructor(options: InstanceLauncherOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.redisClient = options.redisClient;
        this.shutdownManager = options.shutdownManager;

        this.launchOrShutdownInstances = this.launchOrShutdownInstances.bind(this);
        this.launchOrShutdownInstancesByGroup = this.launchOrShutdownInstancesByGroup.bind(this);
    }

    async launchOrShutdownInstances(ctx: Context): Promise<boolean> {
        ctx.logger.debug('[Launcher] Starting to process scaling activities');
        ctx.logger.debug('[Launcher] Obtaining request lock in redis');

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockScaleProcessing(ctx);
        } catch (err) {
            ctx.logger.warn(`[Launcher] Error obtaining lock for processing`, { err });
            return false;
        }

        try {
            const instanceGroups: Array<InstanceGroup> = await this.instanceGroupManager.getAllInstanceGroups(ctx);
            await Promise.all(instanceGroups.map((group) => this.launchOrShutdownInstancesByGroup(ctx, group)));
            ctx.logger.debug('[Launcher] Stopped to process scaling activities');
        } catch (err) {
            ctx.logger.error(`[Launcher] Processing launch instances ${err}`);
        } finally {
            lock.unlock();
        }
        return true;
    }

    async launchOrShutdownInstancesByGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        const groupName = group.name;
        const desiredCount = group.scalingOptions.desiredCount;
        const currentInventory = await this.jibriTracker.getCurrent(ctx, groupName);
        const count = currentInventory.length;

        // set stat for current count of instances
        instancesCount.set({ group: group.name }, count);
        try {
            if (count < group.scalingOptions.desiredCount && count < group.scalingOptions.maxDesired) {
                ctx.logger.info('[Launcher] Will scale up to the desired count', { groupName, desiredCount, count });

                const actualScaleUpQuantity =
                    Math.min(group.scalingOptions.maxDesired, group.scalingOptions.desiredCount) - count;
                const scaleDownProtected = await this.instanceGroupManager.isScaleDownProtected(group.name);
                await this.cloudManager.scaleUp(ctx, group, count, actualScaleUpQuantity, scaleDownProtected);

                // increment launched instance stats for the group
                instancesLaunched.inc({ group: group.name }, actualScaleUpQuantity);
            } else if (count > group.scalingOptions.desiredCount && count > group.scalingOptions.minDesired) {
                ctx.logger.info('[Launcher] Will scale down to the desired count', { groupName, desiredCount, count });

                const actualScaleDownQuantity =
                    count - Math.max(group.scalingOptions.minDesired, group.scalingOptions.desiredCount);

                const availableInstances = this.getAvailableJibris(currentInventory);
                ctx.logger.info('[Launcher] Available instances for scale down', {
                    groupName,
                    availableInstances,
                });

                const unprotectedInstances = await this.filterOutProtectedInstances(ctx, availableInstances);
                ctx.logger.info('[Launcher] Available instances for scale down that are not in protected mode', {
                    groupName,
                    unprotectedInstances,
                });

                const scaleDownInstances = unprotectedInstances.slice(0, actualScaleDownQuantity);
                await this.cloudManager.scaleDown(ctx, group, scaleDownInstances);

                instancesDownscaled.inc({ group: group.name }, actualScaleDownQuantity);
            } else {
                ctx.logger.info(
                    `[Launcher] No scaling activity needed for group ${groupName} with ${count} instances.`,
                );
            }
        } catch (err) {
            instanceErrors.inc({ group: group.name });
            throw err;
        }
        return true;
    }

    async filterOutProtectedInstances(
        ctx: Context,
        instanceDetails: Array<InstanceDetails>,
    ): Promise<Array<InstanceDetails>> {
        const protectedInstances: boolean[] = await Promise.all(
            instanceDetails.map((instance) => {
                return this.shutdownManager.isScaleDownProtected(ctx, instance.instanceId);
            }),
        );

        return instanceDetails.filter((instances, index) => !protectedInstances[index]);
    }

    getAvailableJibris(states: Array<JibriState>): Array<InstanceDetails> {
        return states
            .filter((response) => {
                return response.status.busyStatus == JibriStatusState.Idle;
            })
            .map((response) => {
                return {
                    instanceId: response.jibriId,
                    instanceType: 'jibri',
                    group: response.metadata.group,
                };
            });
    }
}
