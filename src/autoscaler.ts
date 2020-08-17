import { JibriMetric, JibriTracker } from './jibri_tracker';

import logger from './logger';
import CloudManager from './cloud_manager';
import Redlock from 'redlock';
import Redis from 'ioredis';

import InstanceGroupManager, { InstanceGroup, ScalingOptions } from './instance_group';
import LockManager from './lock_manager';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;

    // autoscalerProcessingLockKey is the name of the key used for redis-based distributed lock.
    static readonly autoscalerProcessingLockKey = 'autoscalerLockKey';

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.redisClient = options.redisClient;

        this.processAutoscaling = this.processAutoscaling.bind(this);
        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }

    async processAutoscaling(): Promise<boolean> {
        logger.debug('Starting to process autoscaling activities');
        logger.debug('Obtaining request lock in redis');

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockAutoscaleProcessing();
        } catch (err) {
            logger.error(`Error obtaining lock for processing`, { err });
            return false;
        }

        try {
            const instanceGroups: Array<InstanceGroup> = await this.instanceGroupManager.getAllInstanceGroups();
            await Promise.all(instanceGroups.map(this.processAutoscalingByGroup));
            logger.debug('Stopped to process autoscaling activities');
        } catch (err) {
            logger.error(`Processing request ${err}`);
        } finally {
            lock.unlock();
        }
        return true;
    }

    async processAutoscalingByGroup(group: InstanceGroup): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(group.name);
        const count = currentInventory.length;

        if (!group.enableAutoScale) {
            logger.info(`Autoscaling not enabled for group ${group.name}`);
            return;
        }
        const autoscalingAllowed = await this.instanceGroupManager.allowAutoscaling(group.name);
        if (!autoscalingAllowed) {
            logger.info(`Wait before allowing another autoscaling activity for group ${group.name}`);
            return;
        } else {
            logger.info(`Evaluating scale computed metrics for group ${group.name}`);
        }

        const maxPeriodCount = Math.max(
            group.scalingOptions.jibriScaleUpPeriodsCount,
            group.scalingOptions.jibriScaleDownPeriodsCount,
        );
        const metricInventoryPerPeriod: Array<Array<JibriMetric>> = await this.jibriTracker.getMetricInventoryPerPeriod(
            group.name,
            maxPeriodCount,
            group.scalingOptions.jibriScalePeriod,
        );

        const availableJibrisPerPeriodForScaleUp: Array<number> = await this.jibriTracker.getAvailableMetricPerPeriod(
            metricInventoryPerPeriod,
            group.scalingOptions.jibriScaleUpPeriodsCount,
        );

        const availableJibrisPerPeriodForScaleDown: Array<number> = await this.jibriTracker.getAvailableMetricPerPeriod(
            metricInventoryPerPeriod,
            group.scalingOptions.jibriScaleDownPeriodsCount,
        );

        logger.info(`Available jibris for scale up decision`, { availableJibrisPerPeriodForScaleUp });
        logger.info('Available jibris for scale down decision', { availableJibrisPerPeriodForScaleDown });

        if (this.evalScaleUpConditionForAllPeriods(availableJibrisPerPeriodForScaleUp, count, group.scalingOptions)) {
            let desiredCount = count + group.scalingOptions.jibriScaleUpQuantity;
            if (desiredCount > group.scalingOptions.jibriMaxDesired) {
                desiredCount = group.scalingOptions.jibriMaxDesired;
            }
            if (desiredCount > group.scalingOptions.jibriDesiredCount) {
                this.updateDesiredCount(desiredCount, group);
                this.instanceGroupManager.setAutoScaleGracePeriod(group.name);
            }
        } else if (
            this.evalScaleDownConditionForAllPeriods(availableJibrisPerPeriodForScaleDown, count, group.scalingOptions)
        ) {
            let desiredCount = count - group.scalingOptions.jibriScaleDownQuantity;
            if (desiredCount < group.scalingOptions.jibriMinDesired) {
                desiredCount = group.scalingOptions.jibriMinDesired;
            }
            if (desiredCount < group.scalingOptions.jibriDesiredCount) {
                this.updateDesiredCount(desiredCount, group);
                this.instanceGroupManager.setAutoScaleGracePeriod(group.name);
            }
        } else {
            logger.info(`No autoscaling activity needed for group ${group.name} with ${count} instances.`);
        }

        return true;
    }

    private async updateDesiredCount(desiredCount: number, group: InstanceGroup) {
        if (desiredCount !== group.scalingOptions.jibriDesiredCount) {
            group.scalingOptions.jibriDesiredCount = desiredCount;
            const groupName = group.name;
            logger.info('Updating desired count to', { groupName, desiredCount });
            await this.instanceGroupManager.upsertInstanceGroup(group);
        }
    }

    evalScaleUpConditionForAllPeriods(
        availableJibrisByPeriod: Array<number>,
        count: number,
        scalingOptions: ScalingOptions,
    ): boolean {
        return availableJibrisByPeriod
            .map((availableForPeriod) => {
                return (
                    (count < scalingOptions.jibriMaxDesired &&
                        availableForPeriod < scalingOptions.jibriScaleUpThreshold) ||
                    count < scalingOptions.jibriMinDesired
                );
            })
            .reduce((previousValue, currentValue) => {
                return previousValue && currentValue;
            });
    }

    evalScaleDownConditionForAllPeriods(
        availableJibrisByPeriod: Array<number>,
        count: number,
        scalingOptions: ScalingOptions,
    ): boolean {
        return availableJibrisByPeriod
            .map((availableForPeriod) => {
                return (
                    count > scalingOptions.jibriMinDesired &&
                    availableForPeriod > scalingOptions.jibriScaleDownThreshold
                );
            })
            .reduce((previousValue, currentValue) => {
                return previousValue && currentValue;
            });
    }
}
