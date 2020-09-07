import { JibriTracker } from './jibri_tracker';
import { Context } from './context';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import { InstanceGroupDesiredValuesRequest } from './handlers';

export interface ValidatorOptions {
    jibriTracker: JibriTracker;
    instanceGroupManager: InstanceGroupManager;
    scaleStatus?: string;
    cloudStatus?: string;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
}

export default class Validator {
    private jibriTracker: JibriTracker;
    private instanceGroupManager: InstanceGroupManager;

    constructor(options: ValidatorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.instanceGroupManager = options.instanceGroupManager;

        this.groupHasActiveInstances = this.groupHasActiveInstances.bind(this);
    }

    async groupHasActiveInstances(context: Context, name: string): Promise<boolean> {
        const jibriStates = await this.jibriTracker.getCurrent(context, name);
        return jibriStates.length > 0;
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

    async canLaunchInstances(name: string, count: number): Promise<boolean> {
        const instanceGroup: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(name);
        return count + instanceGroup.scalingOptions.desiredCount <= instanceGroup.scalingOptions.maxDesired;
    }
}
