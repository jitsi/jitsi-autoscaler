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
    initialGroupList: Array<InstanceGroup>;
    groupJobsCreationGracePeriod: number;
    sanityJobsCreationGracePeriod: number;
}

export default class InstanceGroupManager {
    private readonly keyPrefix = 'group:';
    private redisClient: Redis.Redis;
    private initialGroupList: Array<InstanceGroup>;
    private processingIntervalSeconds: number;
    private sanityJobsIntervalSeconds: number;

    constructor(options: InstanceGroupManagerOptions) {
        this.redisClient = options.redisClient;
        this.initialGroupList = options.initialGroupList;
        this.processingIntervalSeconds = options.groupJobsCreationGracePeriod;
        this.sanityJobsIntervalSeconds = options.sanityJobsCreationGracePeriod;

        this.init = this.init.bind(this);
        this.getGroupKey = this.getGroupKey.bind(this);
        this.getInstanceGroup = this.getInstanceGroup.bind(this);
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

    getGroupKey(groupName: string): string {
        return this.keyPrefix + groupName;
    }

    async existsAtLeastOneGroup(): Promise<boolean> {
        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `${this.keyPrefix}*`);
            cursor = result[0];
            if (result[1].length > 0) {
                const items = await this.redisClient.mget(...result[1]);
                if (items.length > 0) {
                    return true;
                }
            }
        } while (cursor != '0');

        return false;
    }

    async upsertInstanceGroup(ctx: Context, group: InstanceGroup): Promise<void> {
        ctx.logger.info(`Storing ${group.name}`);
        const groupKey = this.getGroupKey(group.name);
        const result = await this.redisClient.set(groupKey, JSON.stringify(group));
        if (result !== 'OK') {
            throw new Error(`unable to set ${groupKey}`);
        }
    }

    async getInstanceGroup(groupName: string): Promise<InstanceGroup> {
        const groupKey = this.getGroupKey(groupName);
        const result = await this.redisClient.get(groupKey);
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

    async getAllInstanceGroups(ctx: Context): Promise<Array<InstanceGroup>> {
        let items: Array<string> = [];
        const instanceGroups: Array<InstanceGroup> = [];

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `${this.keyPrefix}*`);
            cursor = result[0];
            if (result[1].length > 0) {
                items = await this.redisClient.mget(...result[1]);
                items.forEach((item) => {
                    const itemJson: InstanceGroup = JSON.parse(item);
                    instanceGroups.push(itemJson);
                });
            }
        } while (cursor != '0');
        ctx.logger.debug(`instance groups are`, { instanceGroups });
        return instanceGroups;
    }

    async deleteInstanceGroup(ctx: Context, groupName: string): Promise<void> {
        ctx.logger.info(`Deleting group ${groupName}`);
        const groupKey = this.getGroupKey(groupName);
        await this.redisClient.del(groupKey);
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
