import { JibriTracker, JibriStatusState } from './jibri_tracker';

import logger from './logger';
import CloudManager, { InstanceDetails } from './cloud_manager';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    jibriGroupList: Array<string>;
    jibriMinDesired: number;
    jibriMaxDesired: number;
    jibriScaleUpQuanity?: number;
    jibriScaleDownQuanity?: number;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;
    private jibriMinDesired: number;
    private jibriMaxDesired: number;
    private jibriScaleUpQuanity = 1;
    private jibriScaleDownQuanity = 1;
    private jibriGroupList: Array<string>;
    private cloudManager: CloudManager;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.jibriMinDesired = options.jibriMinDesired;
        this.jibriMaxDesired = options.jibriMaxDesired;
        this.jibriGroupList = options.jibriGroupList;

        if (options.jibriScaleUpQuanity) {
            this.jibriScaleUpQuanity = options.jibriScaleUpQuanity;
        }
        if (options.jibriScaleDownQuanity) {
            this.jibriScaleDownQuanity = options.jibriScaleDownQuanity;
        }

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
        let region = '';

        const minDesired = this.jibriMinDesired;
        const maxDesired = this.jibriMaxDesired;

        logger.info('inventory', { group, currentInventory });

        currentInventory.forEach((item) => {
            // @TODO: make this prettier, pull region from group definition in config
            if (item.metadata && item.metadata.region) {
                region = item.metadata.region;
            }
            if (item.status.busyStatus == JibriStatusState.Idle) {
                idleCount += 1;
            }
        });

        if (idleCount < maxDesired || count < minDesired) {
            // scale up here
            // TODO: scale up quantity by group
            logger.info('Group should scale up, idle count not high enough', { group, idleCount, minDesired });
            this.cloudManager.scaleUp(group, region, this.jibriScaleUpQuanity);
        }

        if (idleCount > maxDesired) {
            // scale down here
            logger.info('Should scale down here, idle count too high', { group, idleCount, maxDesired })
            // TODO: select instances to be scaled down
            const scaleDownInstances: InstanceDetails[] = [];
            this.cloudManager.scaleDown(group, region, scaleDownInstances);
        }
        return true;
    }
}
