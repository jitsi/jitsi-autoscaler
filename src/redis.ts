import { Context } from './context';
import InstanceStore, { InstanceDetails, InstanceState } from './instance_store';
import MetricsStore, { InstanceMetric } from './metrics_store';
import Redis from 'ioredis';

export interface RedisMetricsOptions {
    redisClient: Redis;
    redisScanCount: number;
    idleTTL: number;
    metricTTL: number;
    provisioningTTL: number;
    shutdownStatusTTL: number;
    groupRelatedDataTTL: number;
}

export default class RedisStore implements MetricsStore, InstanceStore {
    private redisClient: Redis;
    private readonly redisScanCount: number;
    private readonly idleTTL: number;
    private readonly provisioningTTL: number;
    private readonly shutdownStatusTTL: number;
    private readonly metricTTL: number;
    private readonly groupRelatedDataTTL: number;

    constructor(options: RedisMetricsOptions) {
        this.redisClient = options.redisClient;
        this.idleTTL = options.idleTTL;
        this.provisioningTTL = options.provisioningTTL;
        this.shutdownStatusTTL = options.shutdownStatusTTL;
        this.metricTTL = options.metricTTL;
        this.groupRelatedDataTTL = options.groupRelatedDataTTL;
    }

    async fetchInstanceMetrics(ctx: Context, group: string): Promise<InstanceMetric[]> {
        const items: string[] = await this.redisClient.zrange(this.getGroupMetricsKey(group), 0, -1);
        return items.map((item) => <InstanceMetric>JSON.parse(item));
    }

    async filterOutAndTrimExpiredStates(
        ctx: Context,
        group: string,
        states: InstanceState[],
    ): Promise<InstanceState[]> {
        return this.doFilterOutAndTrimExpiredStates(ctx, this.getGroupInstancesStatesKey(group), states);
    }

    private async doFilterOutAndTrimExpiredStates(
        ctx: Context,
        groupInstancesStatesKey: string,
        instanceStates: Array<InstanceState>,
    ): Promise<Array<InstanceState>> {
        const groupInstancesStatesResponse: Array<InstanceState> = [];
        const deletePipeline = this.redisClient.pipeline();

        const shutdownStatuses: boolean[] = await this.getShutdownStatuses(
            ctx,
            instanceStates.map((instanceState) => {
                return instanceState.instanceId;
            }),
        );

        for (let i = 0; i < instanceStates.length; i++) {
            const state = instanceStates[i];
            let statusTTL = this.idleTTL;
            if (state.status && state.status.provisioning) {
                statusTTL = this.provisioningTTL;
            }

            const isInstanceShuttingDown = state.isShuttingDown || shutdownStatuses[i];
            if (isInstanceShuttingDown) {
                // We keep shutdown status a bit longer, to be consistent to Oracle Search API which has a delay in seeing Terminating status
                statusTTL = this.shutdownStatusTTL;
            }

            const expiresAt = new Date(state.timestamp + 1000 * statusTTL);
            const isValidState: boolean = expiresAt >= new Date();
            if (isValidState) {
                groupInstancesStatesResponse.push(state);
            } else {
                deletePipeline.hdel(groupInstancesStatesKey, state.instanceId);
                ctx.logger.debug(`will delete expired state:`, {
                    expiresAt,
                    state,
                });
            }
        }
        await deletePipeline.exec();
        return groupInstancesStatesResponse;
    }

    async fetchInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        let states: Array<InstanceState> = [];
        const currentStart = process.hrtime();
        const groupInstancesStatesKey = this.getGroupInstancesStatesKey(group);

        // Extend TTL longer enough for the key to be deleted only after the group is deleted or no action is performed on it
        await this.extendTTLForKey(groupInstancesStatesKey, this.groupRelatedDataTTL);

        let cursor = '0';
        let scanCounts = 0;
        do {
            const result = await this.redisClient.hscan(
                groupInstancesStatesKey,
                cursor,
                'MATCH',
                `*`,
                'COUNT',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const instanceStates = await this.getInstanceStates(result[1], groupInstancesStatesKey);
                const validInstanceStates = await this.filterOutAndTrimExpiredStates(
                    ctx,
                    groupInstancesStatesKey,
                    instanceStates,
                );
                states = states.concat(validInstanceStates);
            }
            scanCounts++;
        } while (cursor != '0');
        ctx.logger.debug(`instance states: ${states}`, { group, states });
        const currentEnd = process.hrtime(currentStart);
        ctx.logger.info(
            `Scanned ${states.length} group instances in ${scanCounts} scans and ${
                currentEnd[0] * 1000 + currentEnd[1] / 1000000
            } ms, for group ${group}`,
        );

        return states;
    }

    private async getInstanceStates(fields: string[], groupInstancesStatesKey: string): Promise<Array<InstanceState>> {
        const instanceStatesResponse: Array<InstanceState> = [];
        const pipeline = this.redisClient.pipeline();

        fields.forEach((instanceId: string) => {
            pipeline.hget(groupInstancesStatesKey, instanceId);
        });
        const instanceStates = await pipeline.exec();

        if (instanceStates) {
            for (const state of instanceStates) {
                if (state[1]) {
                    instanceStatesResponse.push(<InstanceState>JSON.parse(<string>state[1]));
                }
            }
        } else {
            return [];
        }

        return instanceStatesResponse;
    }

    async fetchInstanceGroups(): Promise<string[]> {
        const groups = await this.redisClient.keys('instances:status:*');
        return groups.map((group) => group.split(':')[2]);
    }

    async saveInstanceStatus(ctx: Context, group: string, state: InstanceState): Promise<boolean> {
        await this.redisClient.hset(
            this.getGroupInstancesStatesKey(group),
            `${state.instanceId}`,
            JSON.stringify(state),
        );

        return true;
    }

    async cleanInstanceMetrics(ctx: Context, group: string): Promise<boolean> {
        const currentTime = Date.now();
        const validUntil = new Date(currentTime - 1000 * this.metricTTL).getTime();

        // Extend TTL longer enough for the key to be deleted only after the group is deleted or no action is performed on it
        await this.extendTTLForKey(this.getGroupMetricsKey(group), this.groupRelatedDataTTL);

        const cleanupStart = process.hrtime();
        const itemsCleanedUp: number = await this.redisClient.zremrangebyscore(
            this.getGroupMetricsKey(group),
            0,
            validUntil,
        );
        const cleanupEnd = process.hrtime(cleanupStart);
        ctx.logger.info(
            `Cleaned up ${itemsCleanedUp} metrics in ${
                cleanupEnd[0] * 1000 + cleanupEnd[1] / 1000000
            } ms, for group ${group}`,
        );

        return (await this.redisClient.del(this.getGroupMetricsKey(group))) == 1;
    }

    private getGroupInstancesStatesKey(groupName: string): string {
        return `instances:status:${groupName}`;
    }

    private getGroupMetricsKey(groupName: string): string {
        return `gmetric:instance:${groupName}`;
    }

    private async extendTTLForKey(key: string, ttl: number): Promise<boolean> {
        const result = await this.redisClient.expire(key, ttl);
        return result == 1;
    }

    async writeInstanceMetric(ctx: Context, group: string, metricObject: InstanceMetric): Promise<boolean> {
        await this.redisClient.zadd(
            this.getGroupMetricsKey(group),
            metricObject.timestamp,
            JSON.stringify(metricObject),
        );

        return true;
    }
    shutDownKey(instanceId: string): string {
        return `instance:shutdown:${instanceId}`;
    }

    shutDownConfirmedKey(instanceId: string): string {
        return `instance:shutdownConfirmed:${instanceId}`;
    }

    protectedKey(instanceId: string): string {
        return `instance:scaleDownProtected:${instanceId}`;
    }

    async setShutdownStatus(
        ctx: Context,
        instanceDetails: InstanceDetails[],
        status = 'shutdown',
        shutdownTTL = 86400,
    ): Promise<boolean> {
        const pipeline = this.redisClient.pipeline();
        for (const instance of instanceDetails) {
            const key = this.shutDownKey(instance.instanceId);
            ctx.logger.debug('Writing shutdown status', { key, status });
            pipeline.set(key, status, 'EX', shutdownTTL);
        }
        await pipeline.exec();
        return true;
    }

    async getShutdownStatuses(ctx: Context, instanceIds: Array<string>): Promise<boolean[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.shutDownKey(instanceId);
            pipeline.get(key);
        });
        const instances = await pipeline.exec();
        if (instances) {
            return instances.map((instance: [error: Error | null, result: unknown]) => {
                return instance[1] == <unknown>'shutdown';
            });
        } else {
            ctx.logger.error('ShutdownStatus Failed in pipeline.exec()');
            return [];
        }
    }

    async getShutdownConfirmations(ctx: Context, instanceIds: Array<string>): Promise<(string | false)[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.shutDownConfirmedKey(instanceId);
            pipeline.get(key);
        });
        const instances = await pipeline.exec();
        if (instances) {
            return instances.map((instance: [error: Error | null, result: unknown]) => {
                if (instance[1] == null) {
                    return false;
                } else {
                    return <string>instance[1];
                }
            });
        } else {
            ctx.logger.error('ShutdownConfirmations Failed in pipeline.exec()');
            return [];
        }
    }

    async getShutdownStatus(ctx: Context, instanceId: string): Promise<boolean> {
        const key = this.shutDownKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read shutdown status', { key, res });
        return res == 'shutdown';
    }

    async setShutdownConfirmation(
        ctx: Context,
        instanceDetails: Array<InstanceDetails>,
        status = new Date().toISOString(),
        shutdownTTL = 86400,
    ) {
        const pipeline = this.redisClient.pipeline();
        for (const instance of instanceDetails) {
            const key = this.shutDownConfirmedKey(instance.instanceId);
            ctx.logger.debug('Writing shutdown confirmation', { key, status });
            pipeline.set(key, status, 'EX', shutdownTTL);
        }
        await pipeline.exec();
        return true;
    }

    async getShutdownConfirmation(ctx: Context, instanceId: string): Promise<false | string> {
        const key = this.shutDownConfirmedKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read shutdown confirmation', { key, res });
        if (res) {
            return res;
        }
        return false;
    }

    async setScaleDownProtected(
        ctx: Context,
        instanceId: string,
        protectedTTL: number,
        mode = 'isScaleDownProtected',
    ): Promise<boolean> {
        const key = this.protectedKey(instanceId);
        ctx.logger.debug('Writing protected mode', { key, mode });
        await this.redisClient.set(key, mode, 'EX', protectedTTL);
        return true;
    }

    async areScaleDownProtected(ctx: Context, instanceIds: Array<string>): Promise<boolean[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.protectedKey(instanceId);
            pipeline.get(key);
        });
        const instances = await pipeline.exec();
        if (instances) {
            return instances.map((instance: [error: Error | null, result: unknown]) => {
                return instance[1] == 'isScaleDownProtected';
            });
        } else {
            ctx.logger.error('ScaleDownProtected Failed in pipeline.exec()');
            return [];
        }
    }
}
