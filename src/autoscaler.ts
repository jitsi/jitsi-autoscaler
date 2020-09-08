import { InstanceMetric, InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import Redlock from 'redlock';
import Redis from 'ioredis';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import LockManager from './lock_manager';
import { Context } from './context';
import * as promClient from 'prom-client';

export interface AutoscaleProcessorOptions {
    instanceTracker: InstanceTracker;
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
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;

    // autoscalerProcessingLockKey is the name of the key used for redis-based distributed lock.
    static readonly autoscalerProcessingLockKey = 'autoscalerLockKey';

    constructor(options: AutoscaleProcessorOptions) {
        this.instanceTracker = options.instanceTracker;
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

        if (
            group.scalingOptions.desiredCount <= count &&
            (await this.evalScaleUpConditionForAllPeriods(ctx, metricInventoryPerPeriod, count, group))
        ) {
            desiredCount = desiredCount + group.scalingOptions.scaleUpQuantity;
            if (desiredCount > group.scalingOptions.maxDesired) {
                desiredCount = group.scalingOptions.maxDesired;
            }
            await this.updateDesiredCount(ctx, desiredCount, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(group);
        } else if (
            desiredCount >= count &&
            (await this.evalScaleDownConditionForAllPeriods(ctx, metricInventoryPerPeriod, count, group))
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

    async evalScaleUpConditionForAllPeriods(
        ctx: Context,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
        count: number,
        group: InstanceGroup,
    ): Promise<boolean> {
        let scaleMetrics: Array<number>;

        switch (group.type) {
            case 'jibri':
                scaleMetrics = await this.instanceTracker.getAvailableMetricPerPeriod(
                    ctx,
                    metricInventoryPerPeriod,
                    group.scalingOptions.scaleUpPeriodsCount,
                );
                ctx.logger.info(
                    `[AutoScaler] Evaluating jibri scale up for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
                    { scaleMetrics },
                );

                return scaleMetrics
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
                // @TODO: implement scale up algorithm for JVB autoscaling
                break;
        }
        return false;
    }

    async evalScaleDownConditionForAllPeriods(
        ctx: Context,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
        count: number,
        group: InstanceGroup,
    ): Promise<boolean> {
        let scaleMetrics: Array<number>;

        switch (group.type) {
            case 'jibri':
                scaleMetrics = await this.instanceTracker.getAvailableMetricPerPeriod(
                    ctx,
                    metricInventoryPerPeriod,
                    group.scalingOptions.scaleDownPeriodsCount,
                );
                ctx.logger.info(
                    `[AutoScaler] Evaluating jibri scale down for group ${group.name} with ${count} instances and current desired count ${group.scalingOptions.desiredCount}`,
                    { scaleMetrics },
                );

                return scaleMetrics
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
                // @TODO: implement scale up algorithm for JVB autoscaling
                break;
        }
        return false;
    }
}
