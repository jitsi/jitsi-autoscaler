import { JibriMetric, JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import Redlock from 'redlock';
import Redis from 'ioredis';
import InstanceGroupManager, { InstanceGroup, ScalingOptions } from './instance_group';
import LockManager from './lock_manager';
import { Context } from './context';
import * as promClient from 'prom-client';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
}

const groupDesired = new promClient.Gauge({
    name: 'autoscaling_desired_count',
    help: 'Gauge for desired count of instances',
    labelNames: ['group'],
});

const groupMax = new promClient.Gauge({
    name: 'autoscaling_maximum_count',
    help: 'Gauge for maxmium count of instances',
    labelNames: ['group'],
});

const groupMin = new promClient.Gauge({
    name: 'autoscaling_minimum_count',
    help: 'Gauge for minimum count of instances',
    labelNames: ['group'],
});

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

        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }

    async processAutoscalingByGroup(ctx: Context, groupName: string): Promise<boolean> {
        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockGroup(ctx, groupName);
        } catch (err) {
            ctx.logger.warn(`[AutoScaler] Error obtaining lock for processing`, { err });
            return false;
        }

        try {
            const group = await this.instanceGroupManager.getInstanceGroup(groupName);
            if (!group) {
                ctx.logger.warn(`[AutoScaler] Failed to process group ${groupName} as it is not found `);
                return false;
            }
            if (!group.enableAutoScale) {
                ctx.logger.info(`[AutoScaler] Autoscaling not enabled for group ${group.name}`);
                return false;
            }
            const autoscalingAllowed = await this.instanceGroupManager.allowAutoscaling(group.name);
            if (!autoscalingAllowed) {
                ctx.logger.info(`[AutoScaler] Wait before allowing desired count adjustments for group ${group.name}`);
                return false;
            }

            ctx.logger.info(`[AutoScaler] Gathering metrics for desired count adjustments for group ${group.name}`);
            const currentInventory = await this.jibriTracker.getCurrent(ctx, group.name);
            const count = currentInventory.length;

            const maxPeriodCount = Math.max(
                group.scalingOptions.scaleUpPeriodsCount,
                group.scalingOptions.scaleDownPeriodsCount,
            );
            const metricInventoryPerPeriod: Array<Array<
                JibriMetric
            >> = await this.jibriTracker.getMetricInventoryPerPeriod(
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

            await this.updateDesiredCountIfNeeded(
                ctx,
                group,
                count,
                availableJibrisPerPeriodForScaleUp,
                availableJibrisPerPeriodForScaleDown,
            );
        } catch (err) {
            ctx.logger.error(`[AutoScaler] Error processing desired count adjustments for group ${groupName} ${err}`);
            throw err;
        } finally {
            lock.unlock();
        }

        return true;
    }

    private async updateDesiredCountIfNeeded(
        ctx: Context,
        group: InstanceGroup,
        count: number,
        availableJibrisPerPeriodForScaleUp: Array<number>,
        availableJibrisPerPeriodForScaleDown: Array<number>,
    ) {
        ctx.logger.info(
            `[AutoScaler] Evaluating desired count adjustments for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
            { availableJibrisPerPeriodForScaleUp, availableJibrisPerPeriodForScaleDown },
        );

        // first check if we should scale up the group
        let desiredCount = group.scalingOptions.desiredCount;
        if (
            group.scalingOptions.desiredCount <= count &&
            this.evalScaleUpConditionForAllPeriods(availableJibrisPerPeriodForScaleUp, count, group.scalingOptions)
        ) {
            desiredCount = desiredCount + group.scalingOptions.scaleUpQuantity;
            if (desiredCount > group.scalingOptions.maxDesired) {
                desiredCount = group.scalingOptions.maxDesired;
            }
            await this.updateDesiredCount(ctx, desiredCount, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(group);
        } else if (
            desiredCount >= count &&
            this.evalScaleDownConditionForAllPeriods(availableJibrisPerPeriodForScaleDown, count, group.scalingOptions)
        ) {
            // next check if we should scale down the group
            desiredCount = group.scalingOptions.desiredCount - group.scalingOptions.scaleDownQuantity;
            if (desiredCount < group.scalingOptions.minDesired) {
                desiredCount = group.scalingOptions.minDesired;
            }
            await this.updateDesiredCount(ctx, desiredCount, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(group);
        } else {
            // otherwise neither action is needed
            ctx.logger.info(
                `[AutoScaler] No desired count adjustments needed for group ${group.name} with ${count} instances`,
            );
        }

        // set current min/max/desired values by group
        groupDesired.set({ group: group.name }, desiredCount);
        groupMin.set({ group: group.name }, group.scalingOptions.minDesired);
        groupMax.set({ group: group.name }, group.scalingOptions.maxDesired);
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
