import Redis from 'ioredis';
import { Context } from './context';

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
    gracePeriodTTLSec: number;
    protectedTTLSec: number;
    scalingOptions: ScalingOptions;
    cloud: string;
}

export interface InstanceGroupManagerOptions {
    redisClient: Redis.Redis;
    redisScanCount: number;
    initialGroupList: Array<InstanceGroup>;
    groupJobsCreationGracePeriod: number;
    sanityJobsCreationGracePeriod: number;
}

export default class InstanceGroupManager {
    private readonly GROUPS_HASH_NAME = 'allgroups';
    private redisClient: Redis.Redis;
    private readonly redisScanCount: number;
    private readonly initialGroupList: Array<InstanceGroup>;
    private readonly processingIntervalSeconds: number;
    private readonly sanityJobsIntervalSeconds: number;

    constructor(options: InstanceGroupManagerOptions) {
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

    async deleteInstanceGroup(ctx: Context, groupName: string): Promise<void> {
        ctx.logger.info(`Deleting group ${groupName}`);
        await this.redisClient.hdel(this.GROUPS_HASH_NAME, groupName);
        ctx.logger.info(`Group ${groupName} is deleted`);
    }

    async allowAutoscaling(group: string): Promise<boolean> {
        const result = await this.redisClient.get(`autoScaleGracePeriod:${group}`);
        return !(result !== null && result.length > 0);
    }

    async setAutoScaleGracePeriod(group: InstanceGroup): Promise<boolean> {
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
