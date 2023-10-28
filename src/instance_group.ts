import Redis from 'ioredis';
import { Context } from './context';
import got from 'got';
import Audit from './audit';

export interface ScalingOptions {
    minDesired: number;
    maxDesired: number;
    desiredCount: number;
    scaleUpQuantity: number;
    scaleDownQuantity: number;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
    scalePeriod: number;
    scaleUpPeriodsCount: number;
    scaleDownPeriodsCount: number;
}

export interface InstanceGroupTags {
    [id: string]: string;
}

export interface GroupMetric {
    groupName: string;
    timestamp: number;
    value: number;
}

export const GroupTypeToGroupMetricKey: { [id: string]: string } = {
    skynet: 'queueSize',
};

export interface InstanceGroup {
    id: string;
    name: string;
    type: string;
    region: string;
    environment: string;
    compartmentId: string;
    instanceConfigurationId: string;
    enableAutoScale: boolean;
    enableLaunch: boolean;
    enableScheduler: boolean;
    enableUntrackedThrottle: boolean;
    enableReconfiguration?: boolean;
    metricsUrl: string;
    gracePeriodTTLSec: number;
    protectedTTLSec: number;
    scalingOptions: ScalingOptions;
    cloud: string;
    tags: InstanceGroupTags;
}

export interface InstanceGroupManagerOptions {
    audit: Audit;
    redisClient: Redis.Redis;
    redisScanCount: number;
    initialGroupList: Array<InstanceGroup>;
    groupJobsCreationGracePeriod: number;
    sanityJobsCreationGracePeriod: number;
}

export default class InstanceGroupManager {
    private readonly GROUPS_HASH_NAME = 'allgroups';
    private readonly audit: Audit;
    private redisClient: Redis.Redis;
    private readonly redisScanCount: number;
    private readonly initialGroupList: Array<InstanceGroup>;
    private readonly processingIntervalSeconds: number;
    private readonly sanityJobsIntervalSeconds: number;

    constructor(options: InstanceGroupManagerOptions) {
        this.audit = options.audit;
        this.redisClient = options.redisClient;
        this.redisScanCount = options.redisScanCount;
        this.initialGroupList = options.initialGroupList;
        this.processingIntervalSeconds = options.groupJobsCreationGracePeriod;
        this.sanityJobsIntervalSeconds = options.sanityJobsCreationGracePeriod;

        this.init = this.init.bind(this);
        this.getInstanceGroup = this.getInstanceGroup.bind(this);
        this.getAllInstanceGroupNames = this.getAllInstanceGroupNames.bind(this);
        this.getAllInstanceGroups = this.getAllInstanceGroups.bind(this);
        this.upsertInstanceGroup = this.upsertInstanceGroup.bind(this);
        this.existsAtLeastOneGroup = this.existsAtLeastOneGroup.bind(this);
    }

    async init(ctx: Context): Promise<void> {
        ctx.logger.info('Initializing instance group manager...');
        const existsAtLeastOneGroup = await this.existsAtLeastOneGroup();
        if (!existsAtLeastOneGroup) {
            ctx.logger.info('Storing instance groups into redis');
            await Promise.all(this.initialGroupList.map((group) => this.upsertInstanceGroup(ctx, group)));
            ctx.logger.info('Stored instance groups into redis');
        }
    }

    getInitialGroups(): Array<InstanceGroup> {
        return this.initialGroupList;
    }

    private getGroupMetricsKey(groupName: string): string {
        return `gmetric:${groupName}`;
    }

    async existsAtLeastOneGroup(): Promise<boolean> {
        let cursor = '0';
        do {
            const result = await this.redisClient.hscan(
                this.GROUPS_HASH_NAME,
                cursor,
                'match',
                `*`,
                'count',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const pipeline = this.redisClient.pipeline();
                result[1].forEach((key: string) => {
                    pipeline.hget(this.GROUPS_HASH_NAME, key);
                });

                const items = await pipeline.exec();
                if (items.length > 0) {
                    return true;
                }
            }
        } while (cursor != '0');

        return false;
    }

    async upsertInstanceGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        ctx.logger.info(`Storing ${group.name}`);
        await this.redisClient.hset(this.GROUPS_HASH_NAME, group.name, JSON.stringify(group));
        return true;
    }

    async getInstanceGroup(groupName: string): Promise<InstanceGroup> {
        const result = await this.redisClient.hget(this.GROUPS_HASH_NAME, groupName);
        if (result !== null && result.length > 0) {
            return JSON.parse(result);
        } else {
            return null;
        }
    }

    async getAllInstanceGroupsAsMap(ctx: Context): Promise<Map<string, InstanceGroup>> {
        const groups = await this.getAllInstanceGroups(ctx);
        return groups.reduce((map: Map<string, InstanceGroup>, group: InstanceGroup) => {
            map.set(group.name, group);
            return map;
        }, new Map<string, InstanceGroup>());
    }

    async getAllInstanceGroupsByTypeRegionEnvironment(
        ctx: Context,
        type: string,
        region: string,
        environment: string,
    ): Promise<Array<InstanceGroup>> {
        const groups = await this.getAllInstanceGroups(ctx);

        function byTypeRegionEnvironment(group: InstanceGroup) {
            return (
                group.type.toLowerCase() == type.toLowerCase() &&
                group.region.toLowerCase() == region.toLowerCase() &&
                group.environment.toLowerCase() == environment.toLowerCase()
            );
        }

        const instanceGroups = groups.filter(byTypeRegionEnvironment);
        ctx.logger.info(
            `Found ${instanceGroups.length} groups environment ${environment} of type ${type} in region ${region}`,
        );
        return instanceGroups;
    }

    async getAllInstanceGroupNames(ctx: Context): Promise<string[]> {
        const start = process.hrtime();
        const result = await this.redisClient.hkeys(this.GROUPS_HASH_NAME);
        const end = process.hrtime(start);
        ctx.logger.info(`Scanned all ${result.length} group names in ${end[0] * 1000 + end[1] / 1000000} ms`);
        return result;
    }

    async getAllInstanceGroups(ctx: Context): Promise<Array<InstanceGroup>> {
        const instanceGroups: Array<InstanceGroup> = [];

        let cursor = '0';
        let scanCount = 0;
        const getGroupsStart = process.hrtime();
        do {
            const result = await this.redisClient.hscan(
                this.GROUPS_HASH_NAME,
                cursor,
                'match',
                `*`,
                'count',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const pipeline = this.redisClient.pipeline();
                result[1].forEach((key: string) => {
                    pipeline.hget(this.GROUPS_HASH_NAME, key);
                });

                const items = await pipeline.exec();
                items.forEach((item) => {
                    if (item[1]) {
                        const itemJson: InstanceGroup = JSON.parse(item[1]);
                        instanceGroups.push(itemJson);
                    }
                });
            }
            scanCount++;
        } while (cursor != '0');
        const getGroupsEnd = process.hrtime(getGroupsStart);
        ctx.logger.debug(`instance groups are`, { instanceGroups });
        ctx.logger.info(
            `Scanned all ${instanceGroups.length} groups in ${scanCount} scans and ${
                getGroupsEnd[0] * 1000 + getGroupsEnd[1] / 1000000
            } ms`,
        );
        return instanceGroups;
    }

    async getAllInstanceGroupsFiltered(ctx: Context, expectedTags: InstanceGroupTags): Promise<Array<InstanceGroup>> {
        const allGroups = await this.getAllInstanceGroups(ctx);

        const filteredGroups = allGroups.filter((group) => InstanceGroupManager.filterGroups(ctx, group, expectedTags));
        ctx.logger.info(`Found groups with tags: ${filteredGroups.length} `, { expectedTags });
        return filteredGroups;
    }

    private static filterGroups(ctx: Context, group: InstanceGroup, expectedTags: InstanceGroupTags): boolean {
        if (!expectedTags || Object.keys(expectedTags).length == 0) {
            return true;
        }

        if (!group.tags) {
            ctx.logger.debug(`Skipping group as it has no tags, for group ${group.name}`);
            return false;
        }

        for (const expectedTagName in expectedTags) {
            const expectedTagValue = expectedTags[expectedTagName];

            if (!group.tags[expectedTagName] || !(group.tags[expectedTagName] === expectedTagValue)) {
                ctx.logger.debug(
                    `Skipping group due to invalid or missing tag, for group ${group.name}, expected tag key: ${expectedTagName}, expected value: ${expectedTagValue}, actual value: ${group.tags[expectedTagName]}`,
                    { tags: group.tags },
                );
                return false;
            }
        }

        return true;
    }

    async deleteInstanceGroup(ctx: Context, groupName: string): Promise<void> {
        ctx.logger.info(`Deleting group ${groupName}`);
        await this.redisClient.hdel(this.GROUPS_HASH_NAME, groupName);
        ctx.logger.info(`Group ${groupName} is deleted`);
    }

    async allowAutoscaling(ctx: Context, group: string): Promise<boolean> {
        const result = await this.redisClient.get(`autoScaleGracePeriod:${group}`);
        ctx.logger.debug(`allowAutoscaling check: ${group}`, { result });

        return !(result !== null && result.length > 0);
    }

    async setAutoScaleGracePeriod(ctx: Context, group: InstanceGroup): Promise<boolean> {
        ctx.logger.info(`resetting autoscale grace period for group ${group.name}: ${group.gracePeriodTTLSec}`, {
            gracePeriodTTLSec: group.gracePeriodTTLSec,
        });
        return this.setValue(`autoScaleGracePeriod:${group.name}`, group.gracePeriodTTLSec);
    }

    async setScaleDownProtected(group: InstanceGroup): Promise<boolean> {
        return this.setValue(`isScaleDownProtected:${group.name}`, group.protectedTTLSec);
    }

    async isScaleDownProtected(group: string): Promise<boolean> {
        const result = await this.redisClient.get(`isScaleDownProtected:${group}`);
        return result !== null && result.length > 0;
    }

    async isGroupJobsCreationAllowed(): Promise<boolean> {
        const result = await this.redisClient.get(`groupJobsCreationGracePeriod`);
        return !(result !== null && result.length > 0);
    }

    async fetchGroupMetrics(ctx: Context, groupName: string): Promise<boolean> {
        try {
            const group = await this.getInstanceGroup(groupName);
            if (!group) {
                throw new Error(`Group ${groupName} not found, failed to report on group metrics`);
            }

            if (!group.metricsUrl) {
                ctx.logger.debug(`Group ${groupName} no metrics url, skipping metrics fetching`);
                return false;
            }

            const metrics: { [id: string]: number } = await got(group.metricsUrl).json();

            const key: string = Object.keys(metrics).find((key) => {
                return GroupTypeToGroupMetricKey[group.type] === key;
            });

            const metricsObject: GroupMetric = {
                groupName,
                timestamp: Date.now(),
                value: metrics[key],
            };

            // store the group metrics
            await this.redisClient.zadd(
                this.getGroupMetricsKey(groupName),
                metricsObject.timestamp,
                JSON.stringify(metricsObject),
            );

            await this.audit.updateLastGroupMetricValue(ctx, groupName, metricsObject.value);
        } catch (e) {
            ctx.logger.error(`Failed to report group metrics for group ${groupName}`, e);
            return false;
        }
    }

    async getGroupMetricInventoryPerPeriod(
        ctx: Context,
        groupName: string,
        periodsCount: number,
        periodDurationSeconds: number,
    ): Promise<Array<Array<GroupMetric>>> {
        const metricPoints: Array<Array<GroupMetric>> = [];
        const metricsKey = this.getGroupMetricsKey(groupName);
        const now = Date.now();
        const items: string[] = await this.redisClient.zrange(metricsKey, 0, -1);

        for (let periodIdx = 0; periodIdx < periodsCount; periodIdx++) {
            metricPoints[periodIdx] = [];
        }

        items.forEach((item) => {
            const itemJson: GroupMetric = JSON.parse(item);
            const periodIdx = Math.floor((now - itemJson.timestamp) / (periodDurationSeconds * 1000));

            if (periodIdx >= 0 && periodIdx < periodsCount) {
                metricPoints[periodIdx].push(itemJson);
            }
        });

        return metricPoints;
    }

    async setGroupJobsCreationGracePeriod(): Promise<boolean> {
        return this.setValue(`groupJobsCreationGracePeriod`, this.processingIntervalSeconds);
    }

    async isSanityJobsCreationAllowed(): Promise<boolean> {
        const result = await this.redisClient.get(`sanityJobsCreationGracePeriod`);
        return !(result !== null && result.length > 0);
    }

    async setSanityJobsCreationGracePeriod(): Promise<boolean> {
        return this.setValue(`sanityJobsCreationGracePeriod`, this.sanityJobsIntervalSeconds);
    }

    async setValue(key: string, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(false), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }
}
