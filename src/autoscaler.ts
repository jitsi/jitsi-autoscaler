import { InstanceMetric, InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import Redlock from 'redlock';
import Redis from 'ioredis';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import LockManager from './lock_manager';
import { Context } from './context';
import Audit from './audit';

interface ScaleChoiceFunction {
    (group: InstanceGroup, count: number, value: number): boolean;
}

export interface AutoscaleProcessorOptions {
    instanceTracker: InstanceTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
    audit: Audit;
}

export default class AutoscaleProcessor {
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;
    private audit: Audit;

    // autoscalerProcessingLockKey is the name of the key used for redis-based distributed lock.
    static readonly autoscalerProcessingLockKey = 'autoscalerLockKey';

    constructor(options: AutoscaleProcessorOptions) {
        this.instanceTracker = options.instanceTracker;
        this.cloudManager = options.cloudManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.redisClient = options.redisClient;
        this.audit = options.audit;

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
                throw new Error(`Group ${groupName} not found, failed to process autoscaling`);
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
            await this.audit.updateLastAutoScalerRun(group.name);

            ctx.logger.info(`[AutoScaler] Gathering metrics for desired count adjustments for group ${group.name}`);
            const currentInventory = await this.instanceTracker.getCurrent(ctx, group.name);
            const count = currentInventory.length;

            const maxPeriodCount = Math.max(
                group.scalingOptions.scaleUpPeriodsCount,
                group.scalingOptions.scaleDownPeriodsCount,
            );
            const metricInventoryPerPeriod: Array<Array<
                InstanceMetric
            >> = await this.instanceTracker.getMetricInventoryPerPeriod(
                ctx,
                group.name,
                maxPeriodCount,
                group.scalingOptions.scalePeriod,
            );

            await this.updateDesiredCountIfNeeded(ctx, group, count, metricInventoryPerPeriod);
        } finally {
            lock.unlock();
        }

        return true;
    }

    private async updateDesiredCountIfNeeded(
        ctx: Context,
        group: InstanceGroup,
        count: number,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
    ) {
        ctx.logger.debug(
            `[AutoScaler] Begin desired count adjustments for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
        );

        // first check if we should scale up the group
        let desiredCount = group.scalingOptions.desiredCount;

        if (group.scalingOptions.desiredCount != count) {
            ctx.logger.info(
                `[AutoScaler] Wait for the launcher to finish scaling up/down instances for group ${group.name}`,
            );
            return;
        }

        const scaleMetrics: Array<number> = await this.instanceTracker.getSummaryMetricPerPeriod(
            ctx,
            group,
            metricInventoryPerPeriod,
            Math.max(group.scalingOptions.scaleUpPeriodsCount, group.scalingOptions.scaleDownPeriodsCount),
        );
        if (scaleMetrics && scaleMetrics.length > 0) {
            // check if we should scale up the group
            if (this.evalScaleConditionForAllPeriods(ctx, scaleMetrics, count, group, 'up')) {
                desiredCount = desiredCount + group.scalingOptions.scaleUpQuantity;
                if (desiredCount > group.scalingOptions.maxDesired) {
                    desiredCount = group.scalingOptions.maxDesired;
                }

                await this.audit.saveAutoScalerActionItem(group.name, {
                    timestamp: Date.now(),
                    actionType: 'increaseDesiredCount',
                    count: count,
                    oldDesiredCount: group.scalingOptions.desiredCount,
                    newDesiredCount: desiredCount,
                    scaleMetrics: scaleMetrics.slice(0, group.scalingOptions.scaleUpPeriodsCount),
                });

                await this.updateDesiredCount(ctx, desiredCount, group);
                await this.instanceGroupManager.setAutoScaleGracePeriod(group);
            } else if (this.evalScaleConditionForAllPeriods(ctx, scaleMetrics, count, group, 'down')) {
                // next check if we should scale down the group
                desiredCount = group.scalingOptions.desiredCount - group.scalingOptions.scaleDownQuantity;
                if (desiredCount < group.scalingOptions.minDesired) {
                    desiredCount = group.scalingOptions.minDesired;
                }

                await this.audit.saveAutoScalerActionItem(group.name, {
                    timestamp: Date.now(),
                    actionType: 'decreaseDesiredCount',
                    count: count,
                    oldDesiredCount: group.scalingOptions.desiredCount,
                    newDesiredCount: desiredCount,
                    scaleMetrics: scaleMetrics.slice(0, group.scalingOptions.scaleDownPeriodsCount),
                });

                await this.updateDesiredCount(ctx, desiredCount, group);
                await this.instanceGroupManager.setAutoScaleGracePeriod(group);
            } else {
                // otherwise neither action is needed
                ctx.logger.info(
                    `[AutoScaler] No desired count adjustments needed for group ${group.name} with ${count} instances`,
                );
            }
        } else {
            ctx.logger.warn(
                `[AutoScaler] No metrics available, no desired count adjustments possible for group ${group.name} with ${count} instances`,
            );
        }
    }

    private async updateDesiredCount(ctx: Context, desiredCount: number, group: InstanceGroup) {
        if (desiredCount !== group.scalingOptions.desiredCount) {
            group.scalingOptions.desiredCount = desiredCount;
            const groupName = group.name;
            ctx.logger.info('Updating desired count to', { groupName, desiredCount });
            await this.instanceGroupManager.upsertInstanceGroup(ctx, group);
        }
    }

    private scaleUpChoice(group: InstanceGroup, count: number, value: number): boolean {
        switch (group.type) {
            case 'jibri':
                // in the jibri case only scale up if value (available count) is below threshold
                return (
                    (count < group.scalingOptions.maxDesired && value < group.scalingOptions.scaleUpThreshold) ||
                    count < group.scalingOptions.minDesired
                );
                break;
            case 'JVB':
                // in the case of JVB scale up only if value (average stress level) is above or equal to threshhold
                return (
                    (count < group.scalingOptions.maxDesired && value >= group.scalingOptions.scaleUpThreshold) ||
                    count < group.scalingOptions.minDesired
                );
                break;
        }
        return false;
    }

    private scaleDownChoice(group: InstanceGroup, count: number, value: number): boolean {
        switch (group.type) {
            case 'jibri':
                // in the jibri case only scale up if value (available count) is above threshold
                return count > group.scalingOptions.minDesired && value > group.scalingOptions.scaleDownThreshold;
            case 'JVB':
                // in the case of JVB scale down only if value (average stress level) is below threshhold
                return count > group.scalingOptions.minDesired && value < group.scalingOptions.scaleDownThreshold;
        }

        return false;
    }

    private evalScaleConditionForAllPeriods(
        ctx: Context,
        scaleMetrics: Array<number>,
        count: number,
        group: InstanceGroup,
        direction: string,
    ): boolean {
        // slice size defines how many metrics to evaluate for scaling decision
        let sliceSize: number;
        // function to determine whether autoscaling conditions have been met
        let scaleChoiceFunction: ScaleChoiceFunction;

        switch (direction) {
            case 'up':
                sliceSize = group.scalingOptions.scaleUpPeriodsCount;
                scaleChoiceFunction = this.scaleUpChoice;
                break;
            case 'down':
                sliceSize = group.scalingOptions.scaleDownPeriodsCount;
                scaleChoiceFunction = this.scaleDownChoice;
                break;
            default:
                ctx.logger.error('Direction not supported', { direction });
                return false;
        }
        ctx.logger.info(
            `[AutoScaler] Evaluating scale ${direction} choice for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
            { scaleMetrics, sliceSize },
        );

        // slice metrics by size, evaluate each period
        // reduce boolean results with && to ensure all periods fulfills autoscaling criteria
        return scaleMetrics
            .slice(0, sliceSize)
            .map((value) => {
                // boolean indicating whether individual metric fulfills autoscaling criteria
                return scaleChoiceFunction(group, count, value);
            })
            .reduce((previousValue, currentValue) => {
                return previousValue && currentValue;
            });
    }
}
