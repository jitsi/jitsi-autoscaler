import { InstanceTracker } from './instance_tracker';
import { Context } from './context';
import { Request } from 'express';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import { InstanceGroupDesiredValuesRequest } from './handlers';

export interface ValidatorOptions {
    instanceTracker: InstanceTracker;
    instanceGroupManager: InstanceGroupManager;
    scaleStatus?: string;
    cloudStatus?: string;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
}

export default class Validator {
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;

    constructor(options: ValidatorOptions) {
        this.instanceTracker = options.instanceTracker;
        this.instanceGroupManager = options.instanceGroupManager;

        this.groupHasActiveInstances = this.groupHasActiveInstances.bind(this);
    }

    async groupHasActiveInstances(context: Context, name: string): Promise<boolean> {
        const instanceStates = await this.instanceTracker.trimCurrent(context, name, false);
        return instanceStates.length > 0;
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
        let max = 0;
        if (req.body.maxDesired != null) {
            if (max > instanceGroup.scalingOptions.maxDesired) {
                max = req.body.maxDesired;
            } else {
                max = instanceGroup.scalingOptions.maxDesired;
            }
        } else {
            max = instanceGroup.scalingOptions.maxDesired;
        }

        return count + instanceGroup.scalingOptions.desiredCount <= max;
    }

    async supportedInstanceType(instanceType: string): Promise<boolean> {
        return (
            instanceType !== null &&
            instanceType !== '' &&
            (instanceType.toLowerCase() == 'jibri' || instanceType.toLowerCase() == 'jvb')
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
