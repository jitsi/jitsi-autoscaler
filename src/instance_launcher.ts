import { InstanceDetails, InstanceState, JibriStatusState, InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import Redis from 'ioredis';
import LockManager from './lock_manager';
import { Context } from './context';
import * as promClient from 'prom-client';
import ShutdownManager from './shutdown_manager';
import Audit from './audit';

const instancesLaunchedCounter = new promClient.Counter({
    name: 'autoscaling_instance_launched_total',
    help: 'Gauge for launched instances',
    labelNames: ['group'],
});

const instancesDownscaledCounter = new promClient.Counter({
    name: 'autoscaling_instance_downscaled_total',
    help: 'Gauge for scaled down instances',
    labelNames: ['group'],
});

const instanceErrorsCounter = new promClient.Counter({
    name: 'autoscaling_instance_errors_total',
    help: 'Gauge for instance errors',
    labelNames: ['group'],
});

export interface InstanceLauncherOptions {
    instanceTracker: InstanceTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
    shutdownManager: ShutdownManager;
    audit: Audit;
}

export default class InstanceLauncher {
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;
    private shutdownManager: ShutdownManager;
    private audit: Audit;

    constructor(options: InstanceLauncherOptions) {
        this.instanceTracker = options.instanceTracker;
        this.cloudManager = options.cloudManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.redisClient = options.redisClient;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;

        this.launchOrShutdownInstancesByGroup = this.launchOrShutdownInstancesByGroup.bind(this);
    }

    async launchOrShutdownInstancesByGroup(ctx: Context, groupName: string): Promise<boolean> {
        const group = await this.instanceGroupManager.getInstanceGroup(groupName);
        if (!group) {
            throw new Error(`Group ${groupName} not found, failed to make launch decisions.`);
        }

        if (!group.enableLaunch) {
            ctx.logger.info(`[Launcher] Scaling not enabled for group ${group.name}`);
            return false;
        }

        await this.audit.updateLastLauncherRun(ctx, group.name);
        const desiredCount = group.scalingOptions.desiredCount;
        const currentInventory = await this.instanceTracker.trimCurrent(ctx, groupName);
        const count = currentInventory.length;

        try {
            if (count < group.scalingOptions.desiredCount && count < group.scalingOptions.maxDesired) {
                ctx.logger.info('[Launcher] Will scale up to the desired count', { groupName, desiredCount, count });

                const actualScaleUpQuantity =
                    Math.min(group.scalingOptions.maxDesired, group.scalingOptions.desiredCount) - count;
                const scaleDownProtected = await this.instanceGroupManager.isScaleDownProtected(group.name);
                const scaleUpCount = await this.cloudManager.scaleUp(
                    ctx,
                    group,
                    count,
                    actualScaleUpQuantity,
                    scaleDownProtected,
                );

                if (scaleUpCount > 0) {
                    await this.audit.saveLauncherActionItem(groupName, {
                        timestamp: Date.now(),
                        actionType: 'scaleUp',
                        count: count,
                        desiredCount: group.scalingOptions.desiredCount,
                        scaleQuantity: scaleUpCount,
                    });

                    // increment launched instance stats for the group
                    instancesLaunchedCounter.inc({ group: group.name }, scaleUpCount);

                    // check if scale up count didn't meet requested quantity, error if so
                    if (scaleUpCount != actualScaleUpQuantity) {
                        ctx.logger.error(
                            `[Launcher] Scaling failed to launch requested new instances for group ${groupName} with ${count} instances.`,
                            { scaleUpRequested: actualScaleUpQuantity, scaleUpActual: scaleUpCount },
                        );
                        throw new Error(
                            `[Launcher] Scaling failed to launch requested new instances for group ${groupName}`,
                        );
                    }
                } else {
                    // something bad happened, so throw an error
                    ctx.logger.error(
                        `[Launcher] Scaling failed to launch ANY new instances for group ${groupName} with ${count} instances.`,
                        { scaleUpQuantity: actualScaleUpQuantity },
                    );
                    throw new Error(`[Launcher] Scaling failed to launch ANY new instances for group ${groupName}`);
                }
            } else if (count > group.scalingOptions.desiredCount && count > group.scalingOptions.minDesired) {
                ctx.logger.info('[Launcher] Will scale down to the desired count', { groupName, desiredCount, count });

                const listOfInstancesForScaleDown = await this.getInstancesForScaleDown(ctx, currentInventory, group);
                await this.cloudManager.scaleDown(ctx, group, listOfInstancesForScaleDown);

                await this.audit.saveLauncherActionItem(groupName, {
                    timestamp: Date.now(),
                    actionType: 'scaleDown',
                    count: count,
                    desiredCount: group.scalingOptions.desiredCount,
                    scaleQuantity: listOfInstancesForScaleDown.length,
                });

                instancesDownscaledCounter.inc({ group: group.name }, listOfInstancesForScaleDown.length);
            } else {
                ctx.logger.info(
                    `[Launcher] No scaling activity needed for group ${groupName} with ${count} instances.`,
                );
            }
        } catch (err) {
            instanceErrorsCounter.inc({ group: group.name });
            throw err;
        }

        return true;
    }

    getJigasisForScaleDown(
        ctx: Context,
        group: InstanceGroup,
        unprotectedInstances: Array<InstanceState>,
        desiredScaleDownQuantity: number,
    ): Array<InstanceDetails> {
        // first sort by participant count
        unprotectedInstances.sort((a, b) => {
            const aParticipants = a.status.jigasiStatus ? a.status.jigasiStatus.participants : 0;
            const bParticipants = b.status.jigasiStatus ? b.status.jigasiStatus.participants : 0;
            return aParticipants - bParticipants;
        });
        const actualScaleDownQuantity = Math.min(desiredScaleDownQuantity, unprotectedInstances.length);
        if (actualScaleDownQuantity < desiredScaleDownQuantity) {
            ctx.logger.error(
                '[Launcher] Nr of Jigasi instances in group for scale down is less than desired scale down quantity',
                { groupName: group.name, actualScaleDownQuantity, desiredScaleDownQuantity },
            );
        }
        // Try to not scale down the running instances unless needed
        // This is needed in case of scale up problems, when we should terminate the provisioning instances first
        let listOfInstancesForScaleDown = this.getProvisioningOrWithoutStatusInstances(unprotectedInstances);
        if (listOfInstancesForScaleDown.length < actualScaleDownQuantity) {
            listOfInstancesForScaleDown = listOfInstancesForScaleDown.concat(
                this.getRunningInstances(unprotectedInstances),
            );
        }

        // now return first N instances, least loaded first
        return listOfInstancesForScaleDown.slice(0, actualScaleDownQuantity);
    }

    getJVBsForScaleDown(
        ctx: Context,
        group: InstanceGroup,
        unprotectedInstances: Array<InstanceState>,
        desiredScaleDownQuantity: number,
    ): Array<InstanceDetails> {
        // first sort by participant count
        unprotectedInstances.sort((a, b) => {
            const aParticipants = a.status.jvbStatus ? a.status.jvbStatus.participants : 0;
            const bParticipants = b.status.jvbStatus ? b.status.jvbStatus.participants : 0;
            return aParticipants - bParticipants;
        });
        const actualScaleDownQuantity = Math.min(desiredScaleDownQuantity, unprotectedInstances.length);
        if (actualScaleDownQuantity < desiredScaleDownQuantity) {
            ctx.logger.error(
                '[Launcher] Nr of JVB instances in group for scale down is less than desired scale down quantity',
                { groupName: group.name, actualScaleDownQuantity, desiredScaleDownQuantity },
            );
        }
        // Try to not scale down the running instances unless needed
        // This is needed in case of scale up problems, when we should terminate the provisioning instances first
        let listOfInstancesForScaleDown = this.getProvisioningOrWithoutStatusInstances(unprotectedInstances);
        if (listOfInstancesForScaleDown.length < actualScaleDownQuantity) {
            listOfInstancesForScaleDown = listOfInstancesForScaleDown.concat(
                this.getRunningInstances(unprotectedInstances),
            );
        }

        // now return first N instances, least loaded first
        return listOfInstancesForScaleDown.slice(0, actualScaleDownQuantity);
    }

    getJibrisForScaleDown(
        ctx: Context,
        group: InstanceGroup,
        unprotectedInstances: Array<InstanceState>,
        desiredScaleDownQuantity: number,
    ): Array<InstanceDetails> {
        const actualScaleDownQuantity = Math.min(desiredScaleDownQuantity, unprotectedInstances.length);
        if (actualScaleDownQuantity < desiredScaleDownQuantity) {
            ctx.logger.error(
                '[Launcher] Nr of Jibri instances in group for scale down is less than desired scale down quantity',
                { groupName: group.name, actualScaleDownQuantity, desiredScaleDownQuantity },
            );
        }
        // Try to not scale down the available and the busy instances unless needed
        // This is needed in case of scale up problems, when we should terminate the provisioning instances first
        let listOfInstancesForScaleDown = this.getProvisioningOrWithoutStatusInstances(unprotectedInstances);

        if (listOfInstancesForScaleDown.length < actualScaleDownQuantity) {
            listOfInstancesForScaleDown = listOfInstancesForScaleDown.concat(
                this.getAvailableJibris(unprotectedInstances),
            );
        }
        if (listOfInstancesForScaleDown.length < actualScaleDownQuantity) {
            listOfInstancesForScaleDown = listOfInstancesForScaleDown.concat(
                this.getExpiredJibris(unprotectedInstances),
            );
        }
        if (listOfInstancesForScaleDown.length < actualScaleDownQuantity) {
            ctx.logger.info(
                '[Launcher] Nr of non-busy Jibris for scale down is less then the desired scale down quantity',
                {
                    groupName: group.name,
                    currentNumber: listOfInstancesForScaleDown.length,
                    actualScaleDownQuantity,
                },
            );
            listOfInstancesForScaleDown = listOfInstancesForScaleDown.concat(this.getBusyJibris(unprotectedInstances));
        }

        listOfInstancesForScaleDown = listOfInstancesForScaleDown.slice(0, actualScaleDownQuantity);
        return listOfInstancesForScaleDown;
    }

    async getInstancesForScaleDown(
        ctx: Context,
        currentInventory: Array<InstanceState>,
        group: InstanceGroup,
    ): Promise<Array<InstanceDetails>> {
        const desiredScaleDownQuantity =
            currentInventory.length - Math.max(group.scalingOptions.minDesired, group.scalingOptions.desiredCount);

        const unprotectedInstances = await this.filterOutProtectedInstances(ctx, currentInventory);

        let listOfInstancesForScaleDown: Array<InstanceDetails> = [];
        switch (group.type) {
            case 'jibri':
            case 'sip-jibri':
                listOfInstancesForScaleDown = this.getJibrisForScaleDown(
                    ctx,
                    group,
                    unprotectedInstances,
                    desiredScaleDownQuantity,
                );
                break;
            case 'jigasi':
                listOfInstancesForScaleDown = this.getJigasisForScaleDown(
                    ctx,
                    group,
                    unprotectedInstances,
                    desiredScaleDownQuantity,
                );
                break;
            case 'JVB':
                listOfInstancesForScaleDown = this.getJVBsForScaleDown(
                    ctx,
                    group,
                    unprotectedInstances,
                    desiredScaleDownQuantity,
                );
                break;
        }
        return listOfInstancesForScaleDown;
    }

    async filterOutProtectedInstances(
        ctx: Context,
        instanceDetails: Array<InstanceState>,
    ): Promise<Array<InstanceState>> {
        const protectedInstances: boolean[] = await this.shutdownManager.areScaleDownProtected(
            ctx,
            instanceDetails.map((instance) => {
                return instance.instanceId;
            }),
        );

        return instanceDetails.filter((instances, index) => !protectedInstances[index]);
    }

    private getProvisioningOrWithoutStatusInstances(instanceStates: Array<InstanceState>): Array<InstanceDetails> {
        const states = instanceStates.filter((instanceState) => {
            return (
                (!instanceState.status.jibriStatus &&
                    !instanceState.status.jvbStatus &&
                    !instanceState.status.jigasiStatus) ||
                instanceState.status.provisioning == true
            );
        });
        return this.mapToInstanceDetails(states);
    }

    private getRunningInstances(instanceStates: Array<InstanceState>): Array<InstanceDetails> {
        const states = instanceStates.filter((instanceState) => {
            return (
                (instanceState.status.jibriStatus || instanceState.status.jvbStatus) &&
                instanceState.status.provisioning == false
            );
        });
        return this.mapToInstanceDetails(states);
    }

    private getAvailableJibris(instanceStates: Array<InstanceState>): Array<InstanceDetails> {
        const states = instanceStates.filter((instanceState) => {
            return (
                instanceState.status.jibriStatus && instanceState.status.jibriStatus.busyStatus == JibriStatusState.Idle
            );
        });
        return this.mapToInstanceDetails(states);
    }

    private getExpiredJibris(instanceStates: Array<InstanceState>): Array<InstanceDetails> {
        const states = instanceStates.filter((instanceState) => {
            return (
                instanceState.status.jibriStatus &&
                instanceState.status.jibriStatus.busyStatus == JibriStatusState.Expired
            );
        });
        return this.mapToInstanceDetails(states);
    }

    private getBusyJibris(instanceStates: Array<InstanceState>): Array<InstanceDetails> {
        const states = instanceStates.filter((instanceState) => {
            return (
                instanceState.status.jibriStatus && instanceState.status.jibriStatus.busyStatus == JibriStatusState.Busy
            );
        });
        return this.mapToInstanceDetails(states);
    }

    private mapToInstanceDetails(states: Array<InstanceState>): Array<InstanceDetails> {
        return states.map((response) => {
            return <InstanceDetails>{
                instanceId: response.instanceId,
                instanceType: response.instanceType,
                group: response.metadata.group,
            };
        });
    }
}
