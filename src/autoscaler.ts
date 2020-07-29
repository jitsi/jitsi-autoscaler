import * as dotenv from 'dotenv';

import { JibriTracker, JibriStatusState } from './jibri_tracker';

import logger from './logger';

dotenv.config();

const MinDesired: number = Number(process.env.JIBRI_MIN_DESIRED) || 1;
const MaxDesired: number = Number(process.env.JIBRI_MAX_DESIRED) || 1;
const GroupList: Array<string> = (process.env.JIBRI_GROUP_LIST || 'default').split(' ');

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.processAutoscaling = this.processAutoscaling.bind(this);
        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }
    async processAutoscaling(): Promise<boolean> {
        await Promise.all(GroupList.map(this.processAutoscalingByGroup))
        return true;
    }

    async processAutoscalingByGroup(group: string): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(group);
        const count = currentInventory.length;
        let idleCount = 0;

        logger.info('inventory', { group, currentInventory });

        currentInventory.forEach(item => {
            if (item.status.busyStatus == JibriStatusState.Idle) {
                idleCount += 1;
            }
        });

        if (idleCount < MinDesired || count < MinDesired) {
            // scale up here
            logger.info('Group should scale up, idle count not high enough', { group, idleCount, MinDesired });
        }

        if (idleCount > MaxDesired) {
            // scale down here
            logger.info('Should scale down here, idle count too high', { group, idleCount, MaxDesired })
        }
        return true;
    }
}
