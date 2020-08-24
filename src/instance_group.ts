import Redis from 'ioredis';
import { Context } from './context';
import { JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';

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
    rotateIntervalSec: number;
    rotateQuantity: number;
}

export interface InstanceGroup {
    id: string;
    name: string;
    region: string;
    compartmentId: string;
    instanceConfigurationId: string;
    enableAutoScale: boolean;
    gracePeriodTTLSec: number;
    scalingOptions: ScalingOptions;
    cloud: string;
}

export interface InstanceGroupManagerOptions {
    redisClient: Redis.Redis;
    initialGroupList: Array<InstanceGroup>;
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
}

export default class InstanceGroupManager {
    private readonly keyPrefix = 'group:';
    private redisClient: Redis.Redis;
    private initialGroupList: Array<InstanceGroup>;
    private jibriTracker: JibriTracker;
    private cloudManager: CloudManager;

    constructor(options: InstanceGroupManagerOptions) {
        this.redisClient = options.redisClient;
        this.initialGroupList = options.initialGroupList;
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;

        this.init = this.init.bind(this);
        this.getGroupKey = this.getGroupKey.bind(this);
        this.getInstanceGroup = this.getInstanceGroup.bind(this);
        this.getAllInstanceGroups = this.getAllInstanceGroups.bind(this);
        this.upsertInstanceGroup = this.upsertInstanceGroup.bind(this);
        this.resetInstanceGroups = this.resetInstanceGroups.bind(this);
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
            throw new Error(`unable to get group by name ${groupName}`);
        }
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
        ctx.logger.debug(`jibri groups are`, { instanceGroups });
        return instanceGroups;
    }

    async deleteInstanceGroup(ctx: Context, groupName: string): Promise<void> {
        ctx.logger.info(`Deleting group ${groupName}`);
        const groupKey = this.getGroupKey(groupName);
        await this.redisClient.del(groupKey);
        ctx.logger.info(`Group ${groupName} is deleted`);
    }

    async resetInstanceGroups(ctx: Context): Promise<void> {
        ctx.logger.info('Resetting instance groups');

        ctx.logger.info('Deleting all instance groups');
        const instanceGroups = await this.getAllInstanceGroups(ctx);
        await Promise.all(instanceGroups.map((group) => this.deleteInstanceGroup(ctx, group.name)));
        ctx.logger.info('Storing instance groups into redis');
        await Promise.all(this.initialGroupList.map((group) => this.upsertInstanceGroup(ctx, group)));

        ctx.logger.info('Instance groups are now reset');
    }

    async rotateInstanceConfigurationOnGroup(
        ctx: Context,
        group: InstanceGroup,
        newInstanceConfigurationId: string,
    ): Promise<void> {
        ctx.logger.info(`Updating instance configuration for group ${group.name}`);

        group.instanceConfigurationId = newInstanceConfigurationId;
        await this.upsertInstanceGroup(ctx, group);
        ctx.logger.info(`Instance configuration is updated for group ${group.name}`);

        const currentInventory = await this.jibriTracker.getCurrent(ctx, group.name);
        const currentJibris = currentInventory.map((response) => {
            return {
                instanceId: response.jibriId,
                instanceType: 'jibri',
                group: response.metadata.group,
            };
        });

        await this.gradualScaleDown(ctx, group, currentJibris);
    }

    async gradualScaleDown(ctx: Context, group: InstanceGroup, currentJibris: InstanceDetails[]): Promise<void> {
        ctx.logger.info(`Gradually scaling down instances from group ${group.name}`);
        const jibris = currentJibris.splice(0, group.scalingOptions.rotateQuantity);
        await this.cloudManager.scaleDown(ctx, group, jibris);

        if (currentJibris.length != 0) {
            setTimeout(
                this.gradualScaleDown.bind(this, ctx, group, currentJibris),
                group.scalingOptions.rotateIntervalSec * 1000,
            );
        } else {
            ctx.logger.info(`Finished scaling down all the instances from group ${group.name}`);
        }
    }

    async rotateInstanceConfigurationOnGroups(ctx: Context, instanceConfigurationId: string): Promise<void> {
        ctx.logger.info(
            `Starting instance configuration rotation on all the groups. New instance configuration id is ${instanceConfigurationId}`,
        );

        const instanceGroups = await this.getAllInstanceGroups(ctx);
        await Promise.all(
            instanceGroups.map((group) => this.rotateInstanceConfigurationOnGroup(ctx, group, instanceConfigurationId)),
        );

        ctx.logger.info('Instance configuration rotation completed for all the groups');
    }

    async allowAutoscaling(group: string): Promise<boolean> {
        const result = await this.redisClient.get(`autoScaleGracePeriod:${group}`);
        return !(result !== null && result.length > 0);
    }

    async allowScaling(group: string): Promise<boolean> {
        const result = await this.redisClient.get(`scaleGracePeriod:${group}`);
        return !(result !== null && result.length > 0);
    }
    async setScaleGracePeriod(group: InstanceGroup): Promise<boolean> {
        return this.setGracePeriod(`scaleGracePeriod:${group.name}`, group.gracePeriodTTLSec);
    }

    async setAutoScaleGracePeriod(group: InstanceGroup): Promise<boolean> {
        return this.setGracePeriod(`autoScaleGracePeriod:${group.name}`, group.gracePeriodTTLSec);
    }

    async setGracePeriod(key: string, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(false), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }
}
