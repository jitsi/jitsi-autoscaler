import { JibriTracker } from './jibri_tracker';
import { Context } from './context';

export default class Validator {
    private jibriTracker: JibriTracker;

    constructor(jibriTracker: JibriTracker) {
        this.jibriTracker = jibriTracker;
        this.groupHasActiveInstances = this.groupHasActiveInstances.bind(this);
    }

    async groupHasActiveInstances(context: Context, name: string): Promise<boolean> {
        const jibriStates = await this.jibriTracker.getCurrent(context, name);
        return jibriStates.length > 0;
    }

    groupHasValidDesiredValues(minDesired: number, maxDesired: number, desiredCount: number): boolean {
        return desiredCount >= minDesired && desiredCount <= maxDesired && minDesired <= maxDesired;
    }
}
