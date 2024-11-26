import { Redis } from 'ioredis';
import * as promClient from 'prom-client';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import { Context } from './context';
import { InstanceTracker } from './instance_tracker';
import { CloudInstance } from './cloud_manager';
import { InstanceState } from './instance_store';

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
    redisClient: Redis;
    metricsTTL: number;
    instanceGroupManager: InstanceGroupManager;
    instanceTracker: InstanceTracker;
    ctx: Context;
}

export default class MetricsLoop {
    private redisClient: Redis;
    private metricsTTL: number;
    private instanceGroupManager: InstanceGroupManager;
    private instanceTracker: InstanceTracker;
    private groupLabels: Set<string>;
    private ctx: Context;

    constructor(options: MetricsLoopOptions) {
        this.redisClient = options.redisClient;
        this.metricsTTL = options.metricsTTL;
        this.instanceGroupManager = options.instanceGroupManager;
        this.instanceTracker = options.instanceTracker;
        this.ctx = options.ctx;
        this.groupLabels = new Set<string>();
    }

    async updateMetrics(): Promise<void> {
        try {
            const instanceGroups: InstanceGroup[] = await this.instanceGroupManager.getAllInstanceGroups(this.ctx);
            this.updateGroupLabelsAndFixMetrics(instanceGroups);

            await Promise.all(
                instanceGroups.map(async (group) => {
                    this.ctx.logger.debug(`Will update metrics for group ${group.name}`);
                    const start = process.hrtime();

                    groupDesired.set({ group: group.name }, group.scalingOptions.desiredCount);
                    groupMin.set({ group: group.name }, group.scalingOptions.minDesired);
                    groupMax.set({ group: group.name }, group.scalingOptions.maxDesired);
                    groupsManaged.set(instanceGroups.length);

                    const currentInventory = await this.instanceTracker.trimCurrent(this.ctx, group.name);
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

                    const end = process.hrtime(start);
                    this.ctx.logger.debug(
                        `Updated metrics for group ${group.name} in ${end[0] * 1000 + end[1] / 1000000} ms`,
                    );
                }),
            );
        } catch (err) {
            this.ctx.logger.warn(`[MetricsLoop] Error updating in memory metrics ${err}`, { err });
            return;
        }
    }

    /**
     * Adds new group labels and removes the no longer existing group labels.
     * Ensures the gauges will no longer hold the values for non-existing groups.
     */
    private updateGroupLabelsAndFixMetrics(instanceGroups: InstanceGroup[]) {
        const instanceGroupNamesSet = new Set<string>();

        instanceGroups.forEach((instanceGroup) => {
            if (instanceGroup.name) {
                const groupName = instanceGroup.name;
                instanceGroupNamesSet.add(groupName);
                this.groupLabels.add(groupName);
            }
        });

        this.groupLabels.forEach((groupLabel) => {
            if (!instanceGroupNamesSet.has(groupLabel)) {
                this.removeGroupMetrics(groupLabel);
                this.groupLabels.delete(groupLabel);
                this.ctx.logger.info(`[MetricsLoop] Deleted invalid metrics group label ${groupLabel}`);
            }
        });
    }

    private removeGroupMetrics(groupName: string) {
        groupDesired.remove(groupName);
        groupMin.remove(groupName);
        groupMax.remove(groupName);
        instancesCount.remove(groupName);
        runningInstancesCount.remove(groupName);
        instancesCountCloud.remove(groupName);
        untrackedInstancesCountCloud.remove(groupName);
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
        const result = await this.redisClient.set(key, JSON.stringify(value), 'EX', ttl);
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
        let cloudInstances: Array<CloudInstance> = [];
        const response = await this.redisClient.get(`cloud-instances-list:${groupName}`);
        if (response !== null && response.length > 0) {
            cloudInstances = JSON.parse(response);
            this.ctx.logger.debug(`Cloud instances: `, { groupName, cloudInstances });
        }

        return cloudInstances;
    }
}
