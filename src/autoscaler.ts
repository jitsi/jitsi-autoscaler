import { JibriTracker } from './jibri_tracker';

import logger from './logger';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';
import { InstanceGroup } from './instance_group';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    jibriGroupList: Array<InstanceGroup>;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;
    private jibriGroupList: Array<InstanceGroup>;
    private cloudManager: CloudManager;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.jibriGroupList = options.jibriGroupList;

        this.processAutoscaling = this.processAutoscaling.bind(this);
        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }

    async processAutoscaling(): Promise<boolean> {
        await Promise.all(this.jibriGroupList.map(this.processAutoscalingByGroup));
        return true;
    }

    async processAutoscalingByGroup(group: InstanceGroup): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(group.name);
        const count = currentInventory.length;

        //TODO get both inventories from one redis call
        const metricInventoryScaleUp = await this.jibriTracker.getMetricPeriods(
            group.name,
            group.scalingOptions.jibriScaleUpPeriodsCount,
            group.scalingOptions.jibriScalePeriod,
        );
        const metricInventoryScaleDown = await this.jibriTracker.getMetricPeriods(
            group.name,
            group.scalingOptions.jibriScaleDownPeriodsCount,
            group.scalingOptions.jibriScalePeriod,
        );

        let computedMetricScaleUp = 0;
        let computedMetricScaleDown = 0;

        metricInventoryScaleUp.forEach((item) => {
            computedMetricScaleUp += item.value;
        });
        computedMetricScaleUp = computedMetricScaleUp / group.scalingOptions.jibriScaleUpPeriodsCount;

        metricInventoryScaleDown.forEach((item) => {
            computedMetricScaleDown += item.value;
        });
        computedMetricScaleDown = computedMetricScaleDown / group.scalingOptions.jibriScaleDownPeriodsCount;

        logger.info('Evaluating scale computed metrics....');

        if (
            (count < group.scalingOptions.jibriMaxDesired &&
                computedMetricScaleUp < group.scalingOptions.jibriScaleUpThreshold) ||
            count < group.scalingOptions.jibriMinDesired
        ) {
            // scale up here
            logger.info('Group should scale up, idle count not high enough', {
                group,
                computedMetricScaleUp,
                count,
            });

            let actualScaleUpQuantity = group.scalingOptions.jibriScaleUpQuantity;
            if (count + actualScaleUpQuantity > group.scalingOptions.jibriMaxDesired) {
                actualScaleUpQuantity = group.scalingOptions.jibriMaxDesired - count;
            }

            this.cloudManager.scaleUp(group, count, actualScaleUpQuantity);
        } else if (
            count > group.scalingOptions.jibriMinDesired &&
            computedMetricScaleDown > group.scalingOptions.jibriScaleDownThreshold
        ) {
            // scale down here
            logger.info('Should scale down here, idle count too high', {
                group,
                computedMetricScaleDown,
                count,
            });

            // TODO: select instances to be scaled down
            const scaleDownInstances: InstanceDetails[] = [];
            this.cloudManager.scaleDown(group, scaleDownInstances);
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
