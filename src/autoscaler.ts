import { JibriTracker } from './jibri_tracker';

import logger from './logger';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    jibriGroupList: Array<string>;
    jibriMinDesired: number;
    jibriMaxDesired: number;
    jibriScaleUpQuantity?: number;
    jibriScaleDownQuantity?: number;
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
    private jibriScaleUpQuantity = 1;
    private jibriScaleDownQuantity = 1;
    private jibriGroupList: Array<string>;
    private cloudManager: CloudManager;
    private jibriScaleUpThreshold: number;
    private jibriScaleDownThreshold: number;
    private jibriScalePeriod: number;
    private jibriScaleUpPeriodsCount: number;
    private jibriScaleDownPeriodsCount: number;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.jibriMinDesired = options.jibriMinDesired;
        this.jibriMaxDesired = options.jibriMaxDesired;
        this.jibriScaleUpThreshold = options.jibriScaleUpThreshold;
        this.jibriScaleDownThreshold = options.jibriScaleDownThreshold;
        this.jibriGroupList = options.jibriGroupList;
        this.jibriScalePeriod = options.jibriScalePeriod;
        this.jibriScaleUpPeriodsCount = options.jibriScaleUpPeriodsCount;
        this.jibriScaleDownPeriodsCount = options.jibriScaleDownPeriodsCount;

        if (options.jibriScaleUpQuantity) {
            this.jibriScaleUpQuantity = options.jibriScaleUpQuantity;
        }
        if (options.jibriScaleDownQuantity > 0) {
            this.jibriScaleDownQuantity = options.jibriScaleDownQuantity;
        }

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
        let region = '';

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

        currentInventory.forEach((item) => {
            // @TODO: make this prettier, pull region from group definition in config
            if (item.metadata && item.metadata.region) {
                region = item.metadata.region;
            }
        });

        metricInventoryScaleUp.forEach((item) => {
            computedMetricScaleUp += item.value;
        });
        computedMetricScaleUp = computedMetricScaleUp / this.jibriScaleUpPeriodsCount;

        metricInventoryScaleDown.forEach((item) => {
            computedMetricScaleDown += item.value;
        });
        computedMetricScaleDown = computedMetricScaleDown / this.jibriScaleDownPeriodsCount;

        logger.info('Evaluating scale computed metrics....');

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

            let actualScaleUpQuantity = this.jibriScaleUpQuantity;
            if (count + actualScaleUpQuantity > this.jibriMaxDesired) {
                actualScaleUpQuantity = this.jibriMaxDesired - count;
            }

            this.cloudManager.scaleUp(group, region, count, actualScaleUpQuantity);
        } else if (count > this.jibriMinDesired && computedMetricScaleDown > this.jibriScaleDownThreshold) {
            // scale down here
            logger.info('Should scale down here, idle count too high', {
                group,
                computedMetricScaleDown,
                count,
            });

            // TODO: select instances to be scaled down
            const scaleDownInstances: InstanceDetails[] = [];
            this.cloudManager.scaleDown(group, region, scaleDownInstances);
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
