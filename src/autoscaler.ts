import { InstanceMetric, InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import Redlock from 'redlock';
import Redis from 'ioredis';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import LockManager from './lock_manager';
import { Context } from './context';
import Audit from './audit';

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

        if (await this.evalScaleUpConditionForAllPeriods(ctx, scaleMetrics, count, group)) {
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
        } else if (await this.evalScaleDownConditionForAllPeriods(ctx, scaleMetrics, count, group)) {
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
    }

    private async updateDesiredCount(ctx: Context, desiredCount: number, group: InstanceGroup) {
        if (desiredCount !== group.scalingOptions.desiredCount) {
            group.scalingOptions.desiredCount = desiredCount;
            const groupName = group.name;
            ctx.logger.info('Updating desired count to', { groupName, desiredCount });
            await this.instanceGroupManager.upsertInstanceGroup(ctx, group);
        }
    }

    async evalScaleUpConditionForAllPeriods(
        ctx: Context,
        scaleMetrics: Array<number>,
        count: number,
        group: InstanceGroup,
    ): Promise<boolean> {
        switch (group.type) {
            case 'jibri':
                ctx.logger.info(
                    `[AutoScaler] Evaluating jibri scale up for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
                    { scaleMetrics },
                );

                return scaleMetrics
                    .slice(0, group.scalingOptions.scaleUpPeriodsCount)
                    .map((availableForPeriod) => {
                        return (
                            (count < group.scalingOptions.maxDesired &&
                                availableForPeriod < group.scalingOptions.scaleUpThreshold) ||
                            count < group.scalingOptions.minDesired
                        );
                    })
                    .reduce((previousValue, currentValue) => {
                        return previousValue && currentValue;
                    });
                break;
            case 'JVB':
                ctx.logger.info(
                    `[AutoScaler] Evaluating JVB scale up for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
                    { scaleMetrics },
                );
                return scaleMetrics
                    .slice(0, group.scalingOptions.scaleUpPeriodsCount)
                    .map((averageForPeriod) => {
                        return (
                            (count < group.scalingOptions.maxDesired &&
                                averageForPeriod >= group.scalingOptions.scaleUpThreshold) ||
                            count < group.scalingOptions.minDesired
                        );
                    })
                    .reduce((previousValue, currentValue) => {
                        return previousValue && currentValue;
                    });
                break;
        }
        return false;
    }

    async evalScaleDownConditionForAllPeriods(
        ctx: Context,
        scaleMetrics: Array<number>,
        count: number,
        group: InstanceGroup,
    ): Promise<boolean> {
        switch (group.type) {
            case 'jibri':
                ctx.logger.info(
                    `[AutoScaler] Evaluating jibri scale down for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
                    { scaleMetrics },
                );

                return scaleMetrics
                    .slice(0, group.scalingOptions.scaleDownPeriodsCount)
                    .map((availableForPeriod) => {
                        return (
                            count > group.scalingOptions.minDesired &&
                            availableForPeriod > group.scalingOptions.scaleDownThreshold
                        );
                    })
                    .reduce((previousValue, currentValue) => {
                        return previousValue && currentValue;
                    });
                break;
            case 'JVB':
                ctx.logger.info(
                    `[AutoScaler] Evaluating JVB scale down for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
                    { scaleMetrics },
                );

                return scaleMetrics
                    .slice(0, group.scalingOptions.scaleDownPeriodsCount)
                    .map((averageForPeriod) => {
                        return (
                            count > group.scalingOptions.minDesired &&
                            averageForPeriod < group.scalingOptions.scaleDownThreshold
                        );
                    })
                    .reduce((previousValue, currentValue) => {
                        return previousValue && currentValue;
                    });
                break;
        }
        return false;
    }
}
