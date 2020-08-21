import { JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import { InstanceDetails, InstanceStatus } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import Redis from 'ioredis';
import Redlock from 'redlock';
import LockManager from './lock_manager';
import { Context } from './context';

export interface InstanceLauncherOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    instanceStatus: InstanceStatus;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
}

export default class InstanceLauncher {
    private jibriTracker: JibriTracker;
    private instanceStatus: InstanceStatus;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;

    constructor(options: InstanceLauncherOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.instanceStatus = options.instanceStatus;
        this.instanceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.redisClient = options.redisClient;

        this.launchOrShutdownInstances = this.launchOrShutdownInstances.bind(this);
        this.launchOrShutdownInstancesByGroup = this.launchOrShutdownInstancesByGroup.bind(this);
    }

    async launchOrShutdownInstances(ctx: Context): Promise<boolean> {
        ctx.logger.debug('Starting to process scaling activities');
        ctx.logger.debug('Obtaining request lock in redis');

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockScaleProcessing(ctx);
        } catch (err) {
            ctx.logger.warn(`Error obtaining lock for processing`, { err });
            return false;
        }

        try {
            const instanceGroups: Array<InstanceGroup> = await this.instanceGroupManager.getAllInstanceGroups(ctx);
            await Promise.all(instanceGroups.map((group) => this.launchOrShutdownInstancesByGroup(ctx, group)));
            ctx.logger.debug('Stopped to process scaling activities');
        } catch (err) {
            ctx.logger.error(`Processing launch instances ${err}`);
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

        if (count < group.scalingOptions.desiredCount && count < group.scalingOptions.maxDesired) {
            ctx.logger.info('Will scale up to the desired count', { groupName, desiredCount, count });

            const actualScaleUpQuantity =
                Math.min(group.scalingOptions.maxDesired, group.scalingOptions.desiredCount) - count;
            await this.cloudManager.scaleUp(ctx, group, count, actualScaleUpQuantity);
        } else if (count > group.scalingOptions.desiredCount && count > group.scalingOptions.minDesired) {
            const currentInventoryShutdownStatus: boolean[] = await Promise.all(
                currentInventory.map((jibriState) => {
                    return (
                        jibriState.shutdownStatus ||
                        this.instanceStatus.getShutdownStatus(ctx, {
                            instanceId: jibriState.jibriId,
                            instanceType: 'jibri',
                        })
                    );
                }),
            );

            const currentNotShuttingDown = currentInventory.filter(
                (jibriState, index) => !currentInventoryShutdownStatus[index],
            );

            const actualScaleDownQuantity =
                currentNotShuttingDown.length -
                Math.max(group.scalingOptions.minDesired, group.scalingOptions.desiredCount);
            if (actualScaleDownQuantity > 0) {
                ctx.logger.info('Will scale down to the desired count', {
                    groupName,
                    desiredCount,
                    count,
                    actualScaleDownQuantity,
                });

                const availableInstances = this.getAvailableJibris(currentNotShuttingDown);
                const scaleDownInstances = availableInstances.slice(0, actualScaleDownQuantity);
                await this.cloudManager.scaleDown(ctx, group, scaleDownInstances);
            } else {
                const countCurrentlyShuttingDown = count - currentNotShuttingDown.length;
                ctx.logger.info(
                    'No need to scale down to desired as there are already enough instances shutting down',
                    {
                        groupName,
                        desiredCount,
                        countCurrentlyShuttingDown,
                        count,
                    },
                );
            }
        } else {
            ctx.logger.info(`No scaling activity needed for group ${groupName} with ${count} instances.`);
        }

        return true;
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
