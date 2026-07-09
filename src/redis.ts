import { CloudInstance } from './cloud_manager';
import { Context } from './context';
import InstanceStore, { InstanceDetails, InstanceGroup, InstanceState } from './instance_store';
import MetricsStore, { InstanceMetric } from './metrics_store';
import { Reservation } from './reservation';
import { ReservationStore } from './reservation_store';
import { partitionExpiredStates } from './instance_state_expiry';
import Redis, { ChainableCommander } from 'ioredis';

type PipelineResult = [error: Error | null, result: unknown];

export interface RedisMetricsOptions {
    redisClient: Redis;
    redisScanCount: number;
    idleTTL: number;
    metricTTL: number;
    provisioningTTL: number;
    shutdownStatusTTL: number;
    groupRelatedDataTTL: number;
    serviceLevelMetricsTTL: number;
}

export default class RedisStore implements MetricsStore, InstanceStore, ReservationStore {
    private readonly GROUPS_HASH_NAME = 'allgroups';
    private redisClient: Redis;
    private readonly redisScanCount: number;
    private readonly idleTTL: number;
    private readonly provisioningTTL: number;
    private readonly shutdownStatusTTL: number;
    private readonly metricTTL: number;
    private readonly serviceLevelMetricsTTL: number;
    private readonly groupRelatedDataTTL: number;

    constructor(options: RedisMetricsOptions) {
        this.redisClient = options.redisClient;
        this.idleTTL = options.idleTTL;
        this.provisioningTTL = options.provisioningTTL;
        this.shutdownStatusTTL = options.shutdownStatusTTL;
        this.metricTTL = options.metricTTL;
        this.groupRelatedDataTTL = options.groupRelatedDataTTL;
        this.serviceLevelMetricsTTL = options.serviceLevelMetricsTTL;
        this.redisScanCount = options.redisScanCount;
    }

    async fetchInstanceMetrics(
        ctx: Context,
        group: string,
        _windowSeconds?: number,
        _stepSeconds?: number,
    ): Promise<InstanceMetric[]> {
        const items: string[] = await this.redisClient.zrange(this.getGroupMetricsKey(group), 0, -1);
        return items.map((item) => <InstanceMetric>JSON.parse(item));
    }

    async filterOutAndTrimExpiredStates(
        ctx: Context,
        group: string,
        states: InstanceState[],
    ): Promise<InstanceState[]> {
        return this.doFilterOutAndTrimExpiredStates(ctx, group, states);
    }

    private async doFilterOutAndTrimExpiredStates(
        ctx: Context,
        group: string,
        instanceStates: InstanceState[],
    ): Promise<InstanceState[]> {
        const groupInstancesStatesKey = this.getGroupInstancesStatesKey(group);
        const deletePipeline = this.redisClient.pipeline();

        const shutdownStatuses: boolean[] = await this.getShutdownStatuses(
            ctx,
            group,
            instanceStates.map((instanceState) => {
                return instanceState.instanceId;
            }),
        );

        // Shared expiry policy (see instance_state_expiry.ts) so Redis and Consul stay in lockstep.
        const { valid, expired } = partitionExpiredStates(
            ctx,
            group,
            instanceStates,
            shutdownStatuses,
            { idleTTL: this.idleTTL, provisioningTTL: this.provisioningTTL, shutdownStatusTTL: this.shutdownStatusTTL },
            Date.now(),
        );
        for (const state of expired) {
            deletePipeline.hdel(groupInstancesStatesKey, state.instanceId);
            ctx.logger.debug(`will delete expired state:`, { state });
        }
        await deletePipeline.exec();
        return valid;
    }

    async fetchInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        let states: InstanceState[] = [];
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
                const instanceStates = await this.getInstanceStates(ctx, result[1], groupInstancesStatesKey);
                const validInstanceStates = await this.filterOutAndTrimExpiredStates(ctx, group, instanceStates);
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

    // Executes a pipeline and returns its per-command results, throwing if exec() returned null or any
    // command errored. Reads must fail closed: a per-command error must never be read as "flag not set"
    // (that would let a shutting-down instance count as active, or a protected instance be scaled down).
    private async execPipelineOrThrow(
        ctx: Context,
        pipeline: ChainableCommander,
        opName: string,
    ): Promise<PipelineResult[]> {
        const results = await pipeline.exec();
        if (!results) {
            ctx.logger.error(`${opName} failed in pipeline.exec()`);
            throw new Error(`${opName} pipeline.exec() returned null`);
        }
        for (const [err] of results) {
            if (err) {
                ctx.logger.error(`${opName} pipeline command errored`, { err });
                throw new Error(`${opName} pipeline command errored: ${err}`);
            }
        }
        return results as PipelineResult[];
    }

    private async getInstanceStates(
        ctx: Context,
        fields: string[],
        groupInstancesStatesKey: string,
    ): Promise<InstanceState[]> {
        const instanceStatesResponse: InstanceState[] = [];
        const pipeline = this.redisClient.pipeline();

        fields.forEach((instanceId: string) => {
            pipeline.hget(groupInstancesStatesKey, instanceId);
        });
        const instanceStates = await this.execPipelineOrThrow(ctx, pipeline, 'getInstanceStates');

        for (const state of instanceStates) {
            if (state[1]) {
                instanceStatesResponse.push(<InstanceState>JSON.parse(<string>state[1]));
            }
        }

        return instanceStatesResponse;
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

        return itemsCleanedUp > 0;
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

    async getShutdownStatuses(ctx: Context, _group: string, instanceIds: string[]): Promise<boolean[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.shutDownKey(instanceId);
            pipeline.get(key);
        });
        const instances = await this.execPipelineOrThrow(ctx, pipeline, 'getShutdownStatuses');
        return instances.map((instance) => instance[1] == <unknown>'shutdown');
    }

    async getShutdownConfirmations(ctx: Context, _group: string, instanceIds: string[]): Promise<(string | false)[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.shutDownConfirmedKey(instanceId);
            pipeline.get(key);
        });
        const instances = await this.execPipelineOrThrow(ctx, pipeline, 'getShutdownConfirmations');
        return instances.map((instance) => {
            if (instance[1] == null) {
                return false;
            } else {
                return <string>instance[1];
            }
        });
    }

    async getShutdownStatus(ctx: Context, _group: string, instanceId: string): Promise<boolean> {
        const key = this.shutDownKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read shutdown status', { key, res });
        return res == 'shutdown';
    }

    async setShutdownConfirmation(
        ctx: Context,
        instanceDetails: InstanceDetails[],
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

    async getShutdownConfirmation(ctx: Context, _group: string, instanceId: string): Promise<false | string> {
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
        group: string,
        instanceId: string,
        protectedTTL: number,
        mode = 'isScaleDownProtected',
    ): Promise<boolean> {
        const key = this.protectedKey(instanceId);
        ctx.logger.debug('Writing protected mode', { group, key, mode });
        await this.redisClient.set(key, mode, 'EX', protectedTTL);
        return true;
    }

    async areScaleDownProtected(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.protectedKey(instanceId);
            pipeline.get(key);
        });
        const instances = await this.execPipelineOrThrow(ctx, pipeline, 'areScaleDownProtected');
        return instances.map((instance) => instance[1] == 'isScaleDownProtected');
    }

    reconfigureKey(instanceId: string): string {
        return `instance:reconfigure:${instanceId}`;
    }

    async setReconfigureDate(
        ctx: Context,
        instanceDetails: InstanceDetails[],
        reconfigureDate = new Date().toISOString(),
        ttl = 86400,
    ): Promise<boolean> {
        const pipeline = this.redisClient.pipeline();
        for (const instance of instanceDetails) {
            const key = this.reconfigureKey(instance.instanceId);
            ctx.logger.debug('Writing reconfigure date', { key, reconfigureDate });
            pipeline.set(key, reconfigureDate, 'EX', ttl);
        }
        await pipeline.exec();
        return true;
    }

    async unsetReconfigureDate(ctx: Context, instanceId: string, group: string): Promise<boolean> {
        const key = this.reconfigureKey(instanceId);
        const res = await this.redisClient.del(key);
        ctx.logger.debug('Remove reconfigure value', { key, res, group });
        return true;
    }

    async getReconfigureDates(ctx: Context, group: string, instanceIds: string[]): Promise<string[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.reconfigureKey(instanceId);
            pipeline.get(key);
        });
        const instances = await this.execPipelineOrThrow(ctx, pipeline, 'getReconfigureDates');
        return instances.map((instance) => <string>instance[1]);
    }

    async getReconfigureDate(ctx: Context, _group: string, instanceId: string): Promise<string> {
        const key = this.reconfigureKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read reconfigure value', { key, res });
        return res;
    }

    async existsAtLeastOneGroup(ctx: Context): Promise<boolean> {
        let cursor = '0';
        do {
            const result = await this.redisClient.hscan(
                this.GROUPS_HASH_NAME,
                cursor,
                'MATCH',
                `*`,
                'COUNT',
                this.redisScanCount,
            );
            if (result) {
                cursor = result[0];
                if (result[1].length > 0) {
                    const pipeline = this.redisClient.pipeline();
                    result[1].forEach((key: string) => {
                        pipeline.hget(this.GROUPS_HASH_NAME, key);
                    });

                    const items = await pipeline.exec();
                    if (items) {
                        if (items.length > 0) {
                            return true;
                        }
                    } else {
                        return false;
                    }
                }
            } else {
                ctx.logger.error('Error scanning groups for existsAtLeastOneGroup');
                return false;
            }
        } while (cursor != '0');

        return false;
    }

    async upsertInstanceGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        ctx.logger.info(`Storing ${group.name}`, { group });
        await this.redisClient.hset(this.GROUPS_HASH_NAME, group.name, JSON.stringify(group));
        return true;
    }

    async getInstanceGroup(_ctx: Context, groupName: string): Promise<InstanceGroup> {
        const result = await this.redisClient.hget(this.GROUPS_HASH_NAME, groupName);
        if (result !== null && result.length > 0) {
            return JSON.parse(result);
        } else {
            return null;
        }
    }

    async getAllInstanceGroupNames(ctx: Context): Promise<string[]> {
        const start = process.hrtime();
        const result = await this.redisClient.hkeys(this.GROUPS_HASH_NAME);
        const end = process.hrtime(start);
        ctx.logger.info(`Scanned all ${result.length} group names in ${end[0] * 1000 + end[1] / 1000000} ms`);
        return result;
    }

    async getAllInstanceGroups(ctx: Context): Promise<InstanceGroup[]> {
        const instanceGroups = <InstanceGroup[]>[];

        let cursor = '0';
        let scanCount = 0;
        const getGroupsStart = process.hrtime();
        do {
            const result = await this.redisClient.hscan(
                this.GROUPS_HASH_NAME,
                cursor,
                'MATCH',
                `*`,
                'COUNT',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const pipeline = this.redisClient.pipeline();
                result[1].forEach((key: string) => {
                    pipeline.hget(this.GROUPS_HASH_NAME, key);
                });

                const items = await pipeline.exec();
                if (items) {
                    items.forEach((item) => {
                        if (item[1]) {
                            const itemJson = <InstanceGroup>JSON.parse(<string>item[1]);
                            instanceGroups.push(itemJson);
                        }
                    });
                }
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
        // Collect reservation keys so they are removed along with the rest of the group data.
        const reservationIds = await this.redisClient.smembers(this.reservationGroupSetKey(groupName));
        const pipeline = this.redisClient
            .pipeline()
            .hdel(this.GROUPS_HASH_NAME, groupName)
            .del(this.getGroupInstancesStatesKey(groupName))
            .del(this.getGroupMetricsKey(groupName))
            .del(`cloud-instances-list:${groupName}`)
            .del(`service-metrics:${groupName}:untracked-count`)
            .del(this.reservationGroupSetKey(groupName))
            .del(this.reservationScaleDownGraceKey(groupName));
        for (const id of reservationIds) {
            pipeline.del(this.reservationKey(id));
        }
        const result = await pipeline.exec();

        if (result) {
            ctx.logger.info(`Group ${groupName} is deleted`, { result });
        } else {
            ctx.logger.error('Error deleting group', { groupName });
        }
        ctx.logger.info(`Group ${groupName} is deleted from all keys`);
        return;
    }

    async checkValue(_ctx: Context, key: string): Promise<boolean> {
        const result = await this.redisClient.get(key);
        return result !== null && result.length > 0;
    }

    async setValue(_ctx: Context, key: string, value: string, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, value, 'EX', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async saveMetricUnTrackedCount(ctx: Context, groupName: string, count: number): Promise<boolean> {
        const key = `service-metrics:${groupName}:untracked-count`;
        const result = await this.redisClient.set(key, JSON.stringify(count), 'EX', this.serviceLevelMetricsTTL);
        if (result !== 'OK') {
            ctx.logger.error('Error saving untracked count', { key, count });
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async saveCloudInstances(_ctx: Context, groupName: string, cloudInstances: CloudInstance[]): Promise<boolean> {
        await this.redisClient.set(
            `cloud-instances-list:${groupName}`,
            JSON.stringify(cloudInstances),
            'EX',
            this.serviceLevelMetricsTTL,
        );
        return true;
    }

    async ping(ctx: Context): Promise<boolean | string> {
        return await new Promise((resolve) => {
            this.redisClient.ping((err, reply) => {
                if (err) {
                    ctx.logger.error('Redis ping error', { err });
                    resolve(false);
                } else {
                    resolve(reply);
                }
            });
        });
    }

    // Reservation store methods

    private reservationKey(id: string): string {
        return `reservation:${id}`;
    }

    private reservationGroupSetKey(groupName: string): string {
        return `reservations:group:${groupName}`;
    }

    private reservationScaleDownGraceKey(groupName: string): string {
        return `reservation:scaledown-grace:${groupName}`;
    }

    async saveReservation(ctx: Context, reservation: Reservation): Promise<void> {
        const key = this.reservationKey(reservation.id);
        const ttl = Math.max(Math.ceil((reservation.expiresAt - Date.now()) / 1000) + 3600, 3600);
        await this.redisClient.set(key, JSON.stringify(reservation), 'EX', ttl);
        await this.redisClient.sadd(this.reservationGroupSetKey(reservation.groupName), reservation.id);
        await this.extendTTLForKey(this.reservationGroupSetKey(reservation.groupName), this.groupRelatedDataTTL);
        ctx.logger.debug('Saved reservation', { reservationId: reservation.id });
    }

    async getReservation(_ctx: Context, id: string): Promise<Reservation | null> {
        const result = await this.redisClient.get(this.reservationKey(id));
        if (result) {
            return JSON.parse(result);
        }
        return null;
    }

    async listReservations(ctx: Context, groupName: string): Promise<Reservation[]> {
        const ids = await this.redisClient.smembers(this.reservationGroupSetKey(groupName));
        if (ids.length === 0) {
            return [];
        }
        const pipeline = this.redisClient.pipeline();
        for (const id of ids) {
            pipeline.get(this.reservationKey(id));
        }
        const results = await pipeline.exec();
        const reservations: Reservation[] = [];
        const expiredIds: string[] = [];
        if (results) {
            for (let i = 0; i < results.length; i++) {
                const value = results[i][1];
                if (value) {
                    reservations.push(JSON.parse(value as string));
                } else {
                    expiredIds.push(ids[i]);
                }
            }
        }
        if (expiredIds.length > 0) {
            await this.redisClient.srem(this.reservationGroupSetKey(groupName), ...expiredIds);
            ctx.logger.debug('Cleaned up expired reservation IDs from set', { groupName, count: expiredIds.length });
        }
        return reservations;
    }

    async deleteReservation(_ctx: Context, id: string, groupName: string): Promise<void> {
        await this.redisClient.del(this.reservationKey(id));
        await this.redisClient.srem(this.reservationGroupSetKey(groupName), id);
    }

    async setScaleDownGrace(_ctx: Context, groupName: string, ttlSec: number): Promise<void> {
        await this.redisClient.set(this.reservationScaleDownGraceKey(groupName), 'active', 'EX', ttlSec);
    }

    async isScaleDownGraceActive(_ctx: Context, groupName: string): Promise<boolean> {
        const result = await this.redisClient.get(this.reservationScaleDownGraceKey(groupName));
        return result !== null;
    }
}
