import { JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import Redis from 'ioredis';
import LockManager from './lock_manager';
import { Context } from './context';
import * as promClient from 'prom-client';
import ShutdownManager from './shutdown_manager';

const instancesCount = new promClient.Gauge({
    name: 'autoscaling_instance_count',
    help: 'Gauge for current instances',
    labelNames: ['group'],
});

const runningInstancesCount = new promClient.Gauge({
    name: 'autoscaling_instance_running',
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

        this.launchOrShutdownInstancesByGroup = this.launchOrShutdownInstancesByGroup.bind(this);
    }

    async launchOrShutdownInstancesByGroup(ctx: Context, groupName: string): Promise<boolean> {
        const group = await this.instanceGroupManager.getInstanceGroup(groupName);
        if (!group) {
            ctx.logger.warn(`[Launcher] Failed to process group ${groupName} as it is not found `);
            return false;
        }

        if (!group.enableLaunch) {
            ctx.logger.info(`[Launcher] Scaling not enabled for group ${group.name}`);
            return false;
        }

        const desiredCount = group.scalingOptions.desiredCount;
        const currentInventory = await this.jibriTracker.getCurrent(ctx, groupName);
        const count = currentInventory.length;

        // set stat for current count of instances
        instancesCount.set({ group: group.name }, count);
        runningInstancesCount.set({ group: group.name }, this.countNonProvisioningInstances(ctx, currentInventory));
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

                const listOfInstancesForScaleDown = await this.getInstancesForScaleDown(ctx, currentInventory, group);
                await this.cloudManager.scaleDown(ctx, group, listOfInstancesForScaleDown);

                instancesDownscaled.inc({ group: group.name }, listOfInstancesForScaleDown.length);
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

    async getInstancesForScaleDown(
        ctx: Context,
        currentInventory: Array<JibriState>,
        group: InstanceGroup,
    ): Promise<Array<InstanceDetails>> {
        const desiredScaleDownQuantity =
            currentInventory.length - Math.max(group.scalingOptions.minDesired, group.scalingOptions.desiredCount);

        const unprotectedInstances = await this.filterOutProtectedInstances(ctx, currentInventory);
        const availableInstances = this.getAvailableJibris(unprotectedInstances);
        let listOfInstancesForScaleDown = availableInstances;
        const actualScaleDownQuantity = listOfInstancesForScaleDown.length;
        if (actualScaleDownQuantity < desiredScaleDownQuantity) {
            const groupName = group.name;
            ctx.logger.info(
                '[Launcher] Nr of available instances for scale down is less then the desired scale down quantity',
                {
                    groupName,
                    actualScaleDownQuantity,
                    desiredScaleDownQuantity,
                },
            );

            const unavailableJibris = this.getUnavailableJibris(unprotectedInstances);
            listOfInstancesForScaleDown = availableInstances.concat(
                unavailableJibris.slice(
                    0,
                    Math.min(unavailableJibris.length, desiredScaleDownQuantity - actualScaleDownQuantity),
                ),
            );
        }
        return listOfInstancesForScaleDown;
    }

    async filterOutProtectedInstances(ctx: Context, instanceDetails: Array<JibriState>): Promise<Array<JibriState>> {
        const protectedInstances: boolean[] = await Promise.all(
            instanceDetails.map((instance) => {
                return this.shutdownManager.isScaleDownProtected(ctx, instance.jibriId);
            }),
        );

        return instanceDetails.filter((instances, index) => !protectedInstances[index]);
    }

    getAvailableJibris(jibriStates: Array<JibriState>): Array<InstanceDetails> {
        const states = jibriStates.filter((jibriState) => {
            return jibriState.status.busyStatus == JibriStatusState.Idle;
        });
        return this.mapToInstanceDetails(states);
    }

    getUnavailableJibris(jibriStates: Array<JibriState>): Array<InstanceDetails> {
        const states = jibriStates.filter((jibriState) => {
            return jibriState.status.busyStatus != JibriStatusState.Idle;
        });
        return this.mapToInstanceDetails(states);
    }

    mapToInstanceDetails(states: Array<JibriState>): Array<InstanceDetails> {
        return states.map((response) => {
            return {
                instanceId: response.jibriId,
                instanceType: 'jibri',
                group: response.metadata.group,
            };
        });
    }

    countNonProvisioningInstances(ctx: Context, states: Array<JibriState>): number {
        let count = 0;
        states.forEach((jibriState) => {
            if (jibriState.status.busyStatus != JibriStatusState.Provisioning) {
                count++;
            }
        });
        return count;
    }
}
