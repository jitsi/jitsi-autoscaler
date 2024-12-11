import { InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import InstanceGroupManager from './instance_group';
import { Context } from './context';
import * as promClient from 'prom-client';
import ShutdownManager from './shutdown_manager';
import Audit from './audit';
import MetricsLoop from './metrics_loop';
import { InstanceDetails, InstanceGroup, InstanceState, JibriStatusState } from './instance_store';

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
    maxThrottleThreshold?: number;
    instanceTracker: InstanceTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    shutdownManager: ShutdownManager;
    audit: Audit;
    metricsLoop: MetricsLoop;
}

export default class InstanceLauncher {
    private maxThrottleThreshold = 40;
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private shutdownManager: ShutdownManager;
    private audit: Audit;
    private metricsLoop: MetricsLoop;

    constructor(options: InstanceLauncherOptions) {
        this.instanceTracker = options.instanceTracker;
        this.cloudManager = options.cloudManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;
        this.metricsLoop = options.metricsLoop;

        if (options.maxThrottleThreshold) {
            this.maxThrottleThreshold = options.maxThrottleThreshold;
        }

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

                // if untracked throttle enabled, only scale up if there aren't too many untracked instances
                if (group.enableUntrackedThrottle == null || group.enableUntrackedThrottle == true) {
                    // use desired scaleUpQuantity to ensure we only scale up this many (plus one) until the previous batch are ready
                    // ensure a maximum threshold from config (default of 40, much higher than ever seen except in cases in which throttling is desired)
                    const untrackedThrottleThreshold = Math.min(
                        group.scalingOptions.maxDesired + 1,
                        this.maxThrottleThreshold,
                    );
                    const untrackedCount = await this.metricsLoop.getUnTrackedCount(group.name);
                    // only allow scale up if untracked count is less than the threshold
                    const allowedScaleUp = untrackedCount < untrackedThrottleThreshold;

                    ctx.logger.debug(
                        `[Launcher] Scaling throttle check for group ${groupName} with ${count} instances.`,
                        { actualScaleUpQuantity, untrackedThrottleThreshold, untrackedCount, allowedScaleUp },
                    );
                    if (!allowedScaleUp) {
                        // not allow to scale at all, error out here
                        ctx.logger.error(
                            `[Launcher] Scaling throttle launch of ALL new instances for group ${groupName} with ${count} instances.`,
                            { untrackedCount, actualScaleUpQuantity, allowedScaleUp },
                        );
                        throw new Error(
                            `[Launcher] Scaling throttled, failed to launch ALL new instances for group ${groupName}`,
                        );
                    } else {
                        ctx.logger.debug(`[Launcher] Scaling throttle check passed for group ${groupName}.`);
                    }
                } else {
                    ctx.logger.debug(`[Launcher] Scaling throttle disabled for group ${groupName}.`);
                }

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
        unprotectedInstances: InstanceState[],
        desiredScaleDownQuantity: number,
    ): InstanceDetails[] {
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

    getNomadsForScaleDown(
        ctx: Context,
        group: InstanceGroup,
        unprotectedInstances: InstanceState[],
        desiredScaleDownQuantity: number,
    ): InstanceDetails[] {
        // first sort by participant count
        unprotectedInstances.sort((a, b) => {
            const aAllocatedCPU = a.status.nomadStatus ? a.status.nomadStatus.allocatedCPU : 0;
            const bAllocatedCPU = b.status.nomadStatus ? b.status.nomadStatus.allocatedCPU : 0;
            return aAllocatedCPU - bAllocatedCPU;
        });
        const actualScaleDownQuantity = Math.min(desiredScaleDownQuantity, unprotectedInstances.length);
        if (actualScaleDownQuantity < desiredScaleDownQuantity) {
            ctx.logger.error(
                '[Launcher] Nr of Nomad instances in group for scale down is less than desired scale down quantity',
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
        unprotectedInstances: InstanceState[],
        desiredScaleDownQuantity: number,
    ): InstanceDetails[] {
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

    getWhisperForScaleDown(
        ctx: Context,
        group: InstanceGroup,
        unprotectedInstances: InstanceState[],
        desiredScaleDownQuantity: number,
    ): InstanceDetails[] {
        // first sort by participant count
        unprotectedInstances.sort((a, b) => {
            const aConnections = a.status.whisperStatus ? a.status.whisperStatus.connections : 0;
            const bConnections = b.status.whisperStatus ? b.status.whisperStatus.connections : 0;
            return aConnections - bConnections;
        });
        const actualScaleDownQuantity = Math.min(desiredScaleDownQuantity, unprotectedInstances.length);
        if (actualScaleDownQuantity < desiredScaleDownQuantity) {
            ctx.logger.error(
                '[Launcher] Nr of whisper instances in group for scale down is less than desired scale down quantity',
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
        unprotectedInstances: InstanceState[],
        desiredScaleDownQuantity: number,
    ): InstanceDetails[] {
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
        currentInventory: InstanceState[],
        group: InstanceGroup,
    ): Promise<InstanceDetails[]> {
        const desiredScaleDownQuantity =
            currentInventory.length - Math.max(group.scalingOptions.minDesired, group.scalingOptions.desiredCount);

        const unprotectedInstances = await this.filterOutProtectedInstances(ctx, currentInventory);

        let listOfInstancesForScaleDown: InstanceDetails[] = [];
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
            case 'nomad':
                listOfInstancesForScaleDown = this.getNomadsForScaleDown(
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
            case 'whisper':
                listOfInstancesForScaleDown = this.getWhisperForScaleDown(
                    ctx,
                    group,
                    unprotectedInstances,
                    desiredScaleDownQuantity,
                );
                break;
        }
        return listOfInstancesForScaleDown;
    }

    async filterOutProtectedInstances(ctx: Context, instanceDetails: InstanceState[]): Promise<InstanceState[]> {
        const protectedInstances: boolean[] = await this.shutdownManager.areScaleDownProtected(
            ctx,
            instanceDetails.map((instance) => {
                return instance.instanceId;
            }),
        );

        return instanceDetails.filter((instances, index) => !protectedInstances[index]);
    }

    private getProvisioningOrWithoutStatusInstances(instanceStates: InstanceState[]): InstanceDetails[] {
        const states = instanceStates.filter((instanceState) => {
            return (
                (!instanceState.status.jibriStatus &&
                    !instanceState.status.jvbStatus &&
                    !instanceState.status.jigasiStatus &&
                    !instanceState.status.nomadStatus) ||
                instanceState.status.provisioning == true
            );
        });
        return this.instanceTracker.mapToInstanceDetails(states);
    }

    private getRunningInstances(instanceStates: InstanceState[]): InstanceDetails[] {
        const states = instanceStates.filter((instanceState) => {
            return (
                (instanceState.status.jibriStatus ||
                    instanceState.status.jvbStatus ||
                    instanceState.status.jigasiStatus ||
                    instanceState.status.nomadStatus) &&
                instanceState.status.provisioning == false
            );
        });
        return this.instanceTracker.mapToInstanceDetails(states);
    }

    private getAvailableJibris(instanceStates: InstanceState[]): InstanceDetails[] {
        const states = instanceStates.filter((instanceState) => {
            return (
                instanceState.status.jibriStatus && instanceState.status.jibriStatus.busyStatus == JibriStatusState.Idle
            );
        });
        return this.instanceTracker.mapToInstanceDetails(states);
    }

    private getExpiredJibris(instanceStates: InstanceState[]): InstanceDetails[] {
        const states = instanceStates.filter((instanceState) => {
            return (
                instanceState.status.jibriStatus &&
                instanceState.status.jibriStatus.busyStatus == JibriStatusState.Expired
            );
        });
        return this.instanceTracker.mapToInstanceDetails(states);
    }

    private getBusyJibris(instanceStates: InstanceState[]): InstanceDetails[] {
        const states = instanceStates.filter((instanceState) => {
            return (
                instanceState.status.jibriStatus && instanceState.status.jibriStatus.busyStatus == JibriStatusState.Busy
            );
        });
        return this.instanceTracker.mapToInstanceDetails(states);
    }
}
