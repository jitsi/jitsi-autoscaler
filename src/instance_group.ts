import Redis from 'ioredis';
import logger from './logger';

export interface ScalingOptions {
    jibriMinDesired: number;
    jibriMaxDesired: number;
    jibriScaleUpQuantity: number;
    jibriScaleDownQuantity: number;
    jibriScaleUpThreshold: number;
    jibriScaleDownThreshold: number;
    jibriScalePeriod: number;
    jibriScaleUpPeriodsCount: number;
    jibriScaleDownPeriodsCount: number;
}

export interface InstanceGroup {
    id: string;
    name: string;
    region: string;
    compartmentId: string;
    instanceConfigurationId: string;
    scalingOptions: ScalingOptions;
    cloud: string;
}

export interface InstanceGroupManagerOptions {
    redisClient: Redis.Redis;
    initialGroupList: Array<InstanceGroup>;
}

export default class InstanceGroupManager {
    private readonly keyPrefix = 'group:';
    private redisClient: Redis.Redis;
    private initialGroupList: Array<InstanceGroup>;

    constructor(options: InstanceGroupManagerOptions) {
        this.redisClient = options.redisClient;
        this.initialGroupList = options.initialGroupList;

        this.init = this.init.bind(this);
        this.getGroupKey = this.getGroupKey.bind(this);
        this.getInstanceGroup = this.getInstanceGroup.bind(this);
        this.getAllInstanceGroups = this.getAllInstanceGroups.bind(this);
        this.upsertInstanceGroup = this.upsertInstanceGroup.bind(this);
    }

    async init(): Promise<void> {
        logger.info('Initializing instance group manager...');
        const result = await this.redisClient.scan(0, 'match', `${this.keyPrefix}*`);
        if (result[1].length == 0) {
            logger.info('Storing instance groups into redis');
            await Promise.all(this.initialGroupList.map(this.upsertInstanceGroup));
            logger.info('Stored instance groups into redis');
        }

        logger.info('Instance group manager initialized.');
    }

    getGroupKey(groupName: string): string {
        return this.keyPrefix + groupName;
    }

    async upsertInstanceGroup(group: InstanceGroup): Promise<void> {
        logger.info(`Storing ${group.name}`);
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
            throw new Error(`unable to get group by name ${groupName}`);
        }
    }

    async getAllInstanceGroups(): Promise<Array<InstanceGroup>> {
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
        logger.debug(`jibri groups are`, { instanceGroups });
        return instanceGroups;
    }

    async deleteInstanceGroup(groupName: string): Promise<void> {
        logger.info(`Deleting group ${groupName}`);
        const groupKey = this.getGroupKey(groupName);
        await this.redisClient.del(groupKey);
        logger.info(`Group ${groupName} is deleted`);
    }

    async resetInstanceGroups(): Promise<void> {
        //TODO grab group processing lock
        logger.info('Resetting instance groups');

        logger.info('Deleting all instance groups');
        const instanceGroups = await this.getAllInstanceGroups();
        await Promise.all(instanceGroups.map((group) => this.deleteInstanceGroup(group.name)));
        logger.info('Storing instance groups into redis');
        await Promise.all(this.initialGroupList.map(this.upsertInstanceGroup));

        logger.info('Instance groups are now reset');
    }
}
