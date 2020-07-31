import * as dotenv from 'dotenv';

import { JibriTracker, JibriStatusState } from './jibri_tracker';

import logger from './logger';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    jibriGroupList: Array<string>;
    jibriMinDesired: number;
    jibriMaxDesired: number;
    jibriScaleUpThreshold: number;
    jibriScaleDownThreshold: number;
    jibriScalePeriod: number;
    jibriScaleUpPeriodsCount: number;
    jibriScaleDownPeriodsCount: number;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;
    private jibriMinDesired: number;
    private jibriMaxDesired: number;
    private jibriScaleUpThreshold: number;
    private jibriScaleDownThreshold: number;
    private jibriGroupList: Array<string>;
    private jibriScalePeriod: number;
    private jibriScaleUpPeriodsCount: number;
    private jibriScaleDownPeriodsCount: number;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.jibriMinDesired = options.jibriMinDesired;
        this.jibriMaxDesired = options.jibriMaxDesired;
        this.jibriScaleUpThreshold = options.jibriScaleUpThreshold;
        this.jibriScaleDownThreshold = options.jibriScaleDownThreshold;
        this.jibriGroupList = options.jibriGroupList;
        this.jibriScalePeriod = options.jibriScalePeriod;
        this.jibriScaleUpPeriodsCount = options.jibriScaleUpPeriodsCount;
        this.jibriScaleDownPeriodsCount = options.jibriScaleDownPeriodsCount;

        this.processAutoscaling = this.processAutoscaling.bind(this);
        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }
    async processAutoscaling(): Promise<boolean> {
        await Promise.all(this.jibriGroupList.map(this.processAutoscalingByGroup));
        return true;
    }

    async processAutoscalingByGroup(group: string): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(group);
        const count = currentInventory.length;

        //TODO get both inventories from one redis call
        const metricInventoryScaleUp = await this.jibriTracker.getMetricPeriods(
            group,
            this.jibriScaleUpPeriodsCount,
            this.jibriScalePeriod,
        );
        const metricInventoryScaleDown = await this.jibriTracker.getMetricPeriods(
            group,
            this.jibriScaleDownPeriodsCount,
            this.jibriScalePeriod,
        );

        let computedMetricScaleUp = 0;
        let computedMetricScaleDown = 0;

        metricInventoryScaleUp.forEach((item) => {
            computedMetricScaleUp += item.value;
        });
        computedMetricScaleUp = computedMetricScaleUp / this.jibriScaleUpPeriodsCount;

        metricInventoryScaleDown.forEach((item) => {
            computedMetricScaleDown += item.value;
        });
        computedMetricScaleDown = computedMetricScaleDown / this.jibriScaleDownPeriodsCount;

        logger.info('===== Evaluating scale computed metrics....');

        if (
            (count < this.jibriMaxDesired && computedMetricScaleUp < this.jibriScaleUpThreshold) ||
            count < this.jibriMinDesired
        ) {
            // scale up here
            logger.info('Group should scale up, idle count not high enough', {
                group,
                computedMetricScaleUp,
                count,
            });
        } else if (count > this.jibriMinDesired && computedMetricScaleDown > this.jibriScaleDownThreshold) {
            // scale down here
            logger.info('Should scale down here, idle count too high', {
                group,
                computedMetricScaleDown,
                count,
            });
        } else {
            logger.info('NOTHING TO BE DONE. ', {
                group,
                computedMetricScaleUp,
                computedMetricScaleDown,
                count,
            });
        }

        return true;
    }
}
