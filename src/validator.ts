import { InstanceTracker } from './instance_tracker';
import { Context } from './context';
import { Request } from 'express';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import { InstanceGroupDesiredValuesRequest } from './handlers';
import MetricsLoop from './metrics_loop';

export interface ValidatorOptions {
    instanceTracker: InstanceTracker;
    metricsLoop: MetricsLoop;
    instanceGroupManager: InstanceGroupManager;
    scaleStatus?: string;
    cloudStatus?: string;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
}

export default class Validator {
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;
    private metricsLoop: MetricsLoop;

    constructor(options: ValidatorOptions) {
        this.instanceTracker = options.instanceTracker;
        this.instanceGroupManager = options.instanceGroupManager;
        this.metricsLoop = options.metricsLoop;

        this.groupHasActiveInstances = this.groupHasActiveInstances.bind(this);
    }

    async groupHasActiveInstances(context: Context, name: string): Promise<boolean> {
        const instanceStates = await this.instanceTracker.trimCurrent(context, name, false);
        const cloudInstances = await this.metricsLoop.getCloudInstances(name);
        const shutdownInstances = cloudInstances
            .filter((cv, _) => {
                return cv.cloudStatus.toLowerCase() == 'shutdown' || cv.cloudStatus.toLowerCase() == 'terminated';
            })
            .map((cv, _) => cv.instanceId);

        return (
            instanceStates.filter((v, _) => {
                // skip any that have completed shutdown
                if (v.shutdownComplete) return false;

                // only include instances that are not listed as SHUTDOWN or TERMINATED
                return !shutdownInstances.includes(v.instanceId);
            }).length > 0
        );
    }

    groupHasValidDesiredValues(minDesired: number, maxDesired: number, desiredCount: number): boolean {
        return desiredCount >= minDesired && desiredCount <= maxDesired && minDesired <= maxDesired;
    }

    async groupHasValidDesiredInput(name: string, request: InstanceGroupDesiredValuesRequest): Promise<boolean> {
        const instanceGroup: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(name);

        const minDesired = request.minDesired != null ? request.minDesired : instanceGroup.scalingOptions.minDesired;
        const maxDesired = request.maxDesired != null ? request.maxDesired : instanceGroup.scalingOptions.maxDesired;
        const desiredCount =
            request.desiredCount != null ? request.desiredCount : instanceGroup.scalingOptions.desiredCount;

        return this.groupHasValidDesiredValues(minDesired, maxDesired, desiredCount);
    }

    async canLaunchInstances(req: Request, count: number): Promise<boolean> {
        const instanceGroup: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
        // take new maximum into consideration, if set
        let max;
        if (req.body.maxDesired != null) {
            max = req.body.maxDesired;
        } else {
            max = instanceGroup.scalingOptions.maxDesired;
        }

        return count + instanceGroup.scalingOptions.desiredCount <= max;
    }

    async supportedInstanceType(instanceType: string): Promise<boolean> {
        return (
            instanceType !== null &&
            instanceType !== '' &&
            (instanceType.toLowerCase() == 'jibri' ||
                instanceType.toLowerCase() == 'sip-jibri' ||
                instanceType.toLowerCase() == 'jigasi' ||
                instanceType.toLowerCase() == 'nomad' ||
                instanceType.toLowerCase() == 'jvb')
        );
    }

    async supportedScalingDirection(direction: string): Promise<boolean> {
        return (
            direction !== null &&
            direction !== '' &&
            (direction.toLowerCase() == 'up' || direction.toLowerCase() == 'down')
        );
    }
}
