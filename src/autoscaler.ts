import { JibriMetric, JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import Redlock from 'redlock';
import Redis from 'ioredis';
import InstanceGroupManager, { InstanceGroup, ScalingOptions } from './instance_group';
import LockManager from './lock_manager';
import { Context } from './context';

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

    async processAutoscaling(ctx: Context): Promise<boolean> {
        ctx.logger.debug('[autoScaler] Starting to process autoscaling activities');
        ctx.logger.debug('[autoScaler] Obtaining request lock in redis');

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockAutoscaleProcessing(ctx);
        } catch (err) {
            ctx.logger.warn(`[autoScaler] Error obtaining lock for processing`, { err });
            return false;
        }

        try {
            const instanceGroups: Array<InstanceGroup> = await this.instanceGroupManager.getAllInstanceGroups(ctx);
            await Promise.all(instanceGroups.map((group) => this.processAutoscalingByGroup(ctx, group)));
            ctx.logger.debug('[autoScaler] Stopped to process autoscaling activities');
        } catch (err) {
            ctx.logger.error(`[autoScaler] Processing request ${err}`);
        } finally {
            lock.unlock();
        }
        return true;
    }

    async processAutoscalingByGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(ctx, group.name);
        const count = currentInventory.length;

        if (!group.enableAutoScale) {
            ctx.logger.info(`[autoScaler] Autoscaling not enabled for group ${group.name}`);
            return;
        }
        const autoscalingAllowed = await this.instanceGroupManager.allowAutoscaling(group.name);
        if (!autoscalingAllowed) {
            ctx.logger.info(`[autoScaler] Wait before allowing desired count adjustments for group ${group.name}`);
            return;
        } else {
            ctx.logger.info(`[autoScaler] Gathering metrics for desired count adjustments for group ${group.name}`);
        }

        const maxPeriodCount = Math.max(
            group.scalingOptions.scaleUpPeriodsCount,
            group.scalingOptions.scaleDownPeriodsCount,
        );
        const metricInventoryPerPeriod: Array<Array<JibriMetric>> = await this.jibriTracker.getMetricInventoryPerPeriod(
            ctx,
            group.name,
            maxPeriodCount,
            group.scalingOptions.scalePeriod,
        );

        const availableJibrisPerPeriodForScaleUp: Array<number> = await this.jibriTracker.getAvailableMetricPerPeriod(
            ctx,
            metricInventoryPerPeriod,
            group.scalingOptions.scaleUpPeriodsCount,
        );

        const availableJibrisPerPeriodForScaleDown: Array<number> = await this.jibriTracker.getAvailableMetricPerPeriod(
            ctx,
            metricInventoryPerPeriod,
            group.scalingOptions.scaleDownPeriodsCount,
        );

        ctx.logger.info(
            `[autoScaler] Evaluating desired count adjustments for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
            { availableJibrisPerPeriodForScaleUp, availableJibrisPerPeriodForScaleDown },
        );

        if (
            group.scalingOptions.desiredCount <= count &&
            this.evalScaleUpConditionForAllPeriods(availableJibrisPerPeriodForScaleUp, count, group.scalingOptions)
        ) {
            let desiredCount = group.scalingOptions.desiredCount + group.scalingOptions.scaleUpQuantity;
            if (desiredCount > group.scalingOptions.maxDesired) {
                desiredCount = group.scalingOptions.maxDesired;
            }
            await this.updateDesiredCount(ctx, desiredCount, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(group);
        } else if (
            group.scalingOptions.desiredCount >= count &&
            this.evalScaleDownConditionForAllPeriods(availableJibrisPerPeriodForScaleDown, count, group.scalingOptions)
        ) {
            let desiredCount = group.scalingOptions.desiredCount - group.scalingOptions.scaleDownQuantity;
            if (desiredCount < group.scalingOptions.minDesired) {
                desiredCount = group.scalingOptions.minDesired;
            }
            await this.updateDesiredCount(ctx, desiredCount, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(group);
        } else {
            ctx.logger.info(
                `[autoScaler] No desired count adjustments needed for group ${group.name} with ${count} instances`,
            );
        }

        return true;
    }

    private async updateDesiredCount(ctx: Context, desiredCount: number, group: InstanceGroup) {
        if (desiredCount !== group.scalingOptions.desiredCount) {
            group.scalingOptions.desiredCount = desiredCount;
            const groupName = group.name;
            ctx.logger.info('Updating desired count to', { groupName, desiredCount });
            await this.instanceGroupManager.upsertInstanceGroup(ctx, group);
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
                    (count < scalingOptions.maxDesired && availableForPeriod < scalingOptions.scaleUpThreshold) ||
                    count < scalingOptions.minDesired
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
                return count > scalingOptions.minDesired && availableForPeriod > scalingOptions.scaleDownThreshold;
            })
            .reduce((previousValue, currentValue) => {
                return previousValue && currentValue;
            });
    }
}
