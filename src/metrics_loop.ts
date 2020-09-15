import Redis from 'ioredis';
import * as promClient from 'prom-client';
import InstanceGroupManager from './instance_group';
import { Context } from './context';
import { InstanceState, InstanceTracker } from './instance_tracker';
import { CloudInstance } from './cloud_manager';

const groupsManaged = new promClient.Gauge({
    name: 'autoscaling_groups_managed',
    help: 'Gauge for groups currently being managed',
});

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

const instancesCount = new promClient.Gauge({
    name: 'autoscaling_instance_count',
    help: 'Gauge for current instances',
    labelNames: ['group'],
});

const runningInstancesCount = new promClient.Gauge({
    name: 'autoscaling_instance_running',
    help: 'Gauge for current instances',
    labelNames: ['group'],
});

const instancesCountCloud = new promClient.Gauge({
    name: 'autoscaling_cloud_instance_count',
    help: 'Gauge for current instances in cloud',
    labelNames: ['group'],
});

const untrackedInstancesCountCloud = new promClient.Gauge({
    name: 'autoscaling_untracked_instance_count',
    help: 'Gauge for current untracked instances',
    labelNames: ['group'],
});

const queueWaiting = new promClient.Gauge({
    name: 'autoscaling_queue_waiting',
    help: 'Gauge for current jobs waiting to be processed',
});

export interface MetricsLoopOptions {
    redisClient: Redis.Redis;
    metricsTTL: number;
    instanceGroupManager: InstanceGroupManager;
    instanceTracker: InstanceTracker;
    ctx: Context;
}

export default class MetricsLoop {
    private redisClient: Redis.Redis;
    private metricsTTL: number;
    private instanceGroupManager: InstanceGroupManager;
    private instanceTracker: InstanceTracker;

    private ctx: Context;

    constructor(options: MetricsLoopOptions) {
        this.redisClient = options.redisClient;
        this.metricsTTL = options.metricsTTL;
        this.instanceGroupManager = options.instanceGroupManager;
        this.instanceTracker = options.instanceTracker;
        this.ctx = options.ctx;
    }

    async updateMetrics(): Promise<void> {
        try {
            const instanceGroups = await this.instanceGroupManager.getAllInstanceGroups(this.ctx);

            await Promise.all(
                instanceGroups.map(async (group) => {
                    this.ctx.logger.debug(`Will update metrics for group ${group.name}`);

                    groupDesired.set({ group: group.name }, group.scalingOptions.desiredCount);
                    groupMin.set({ group: group.name }, group.scalingOptions.minDesired);
                    groupMax.set({ group: group.name }, group.scalingOptions.maxDesired);
                    groupsManaged.set(instanceGroups.length);

                    const currentInventory = await this.instanceTracker.getCurrent(this.ctx, group.name);
                    instancesCount.set({ group: group.name }, currentInventory.length);
                    runningInstancesCount.set(
                        { group: group.name },
                        this.countNonProvisioningInstances(this.ctx, currentInventory),
                    );

                    const cloudInstances = await this.getCloudInstances(group.name);
                    instancesCountCloud.set({ group: group.name }, cloudInstances.length);

                    const unTrackedCount = await this.getUnTrackedCount(group.name);
                    untrackedInstancesCountCloud.set({ group: group.name }, unTrackedCount);

                    const queueWaitingCount = await this.getQueueWaitingCount();
                    queueWaiting.set(queueWaitingCount);
                }),
            );
        } catch (err) {
            this.ctx.logger.warn(`[MetricsLoop] Error updating in memory metrics`, { err });
            return;
        }
    }

    countNonProvisioningInstances(ctx: Context, states: Array<InstanceState>): number {
        let count = 0;
        states.forEach((instanceState) => {
            if (!instanceState.status.provisioning) {
                count++;
            }
        });
        return count;
    }

    async saveMetricQueueWaiting(count: number): Promise<boolean> {
        return this.setValue(`service-metrics:queue-waiting`, count, this.metricsTTL);
    }

    async setValue(key: string, value: number, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(value), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async getQueueWaitingCount(): Promise<number> {
        const response = await this.redisClient.get(`service-metrics:queue-waiting`);
        if (response !== null && response.length > 0) {
            return Number.parseFloat(response) || 0;
        } else {
            return 0;
        }
    }

    async getUnTrackedCount(groupName: string): Promise<number> {
        const response = await this.redisClient.get(`service-metrics:${groupName}:untracked-count`);
        if (response !== null && response.length > 0) {
            return Number.parseFloat(response) || 0;
        } else {
            return 0;
        }
    }

    async getCloudInstances(groupName: string): Promise<Array<CloudInstance>> {
        const cloudInstances: Array<CloudInstance> = [];
        let items: Array<string> = [];

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `cloud-instances:${groupName}:*`);
            cursor = result[0];
            if (result[1].length > 0) {
                items = await this.redisClient.mget(...result[1]);
                items.forEach((item) => {
                    if (item) {
                        cloudInstances.push(JSON.parse(item));
                    }
                });
            }
        } while (cursor != '0');
        this.ctx.logger.debug(`Cloud instances: `, { groupName, cloudInstances });

        return cloudInstances;
    }
}
