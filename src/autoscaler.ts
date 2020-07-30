import * as dotenv from 'dotenv';

import { JibriTracker, JibriStatusState } from './jibri_tracker';

import logger from './logger';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    jibriGroupList: Array<string>;
    jibriMinDesired: number;
    jibriMaxDesired: number;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;
    private jibriMinDesired: number;
    private jibriMaxDesired: number;
    private jibriGroupList: Array<string>;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.jibriMinDesired = options.jibriMinDesired;
        this.jibriMaxDesired = options.jibriMaxDesired;
        this.jibriGroupList = options.jibriGroupList;

        this.processAutoscaling = this.processAutoscaling.bind(this);
        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }
    async processAutoscaling(): Promise<boolean> {
        await Promise.all(this.jibriGroupList.map(this.processAutoscalingByGroup))
        return true;
    }

    async processAutoscalingByGroup(group: string): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(group);
        const count = currentInventory.length;
        let idleCount = 0;

        const minDesired = this.jibriMinDesired;
        const maxDesired = this.jibriMaxDesired;

        logger.info('inventory', { group, currentInventory });

        currentInventory.forEach(item => {
            if (item.status.busyStatus == JibriStatusState.Idle) {
                idleCount += 1;
            }
        });

        if (idleCount < maxDesired || count < minDesired) {
            // scale up here
            logger.info('Group should scale up, idle count not high enough', { group, idleCount, minDesired });
        }

        if (idleCount > maxDesired) {
            // scale down here
            logger.info('Should scale down here, idle count too high', { group, idleCount, maxDesired })
        }
        return true;
    }
}
