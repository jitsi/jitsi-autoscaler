import { Redis } from 'ioredis';
import { Context } from './context';
import Audit from './audit';
import { InstanceDetails } from './instance_tracker';

export interface ShutdownManagerOptions {
    redisClient: Redis;
    shutdownTTL: number;
    audit: Audit;
}

export default class ShutdownManager {
    private redisClient: Redis;
    private shutdownTTL: number;
    private audit: Audit;

    constructor(options: ShutdownManagerOptions) {
        this.redisClient = options.redisClient;
        this.shutdownTTL = options.shutdownTTL;
        this.audit = options.audit;
    }

    shutDownKey(instanceId: string): string {
        return `instance:shutdown:${instanceId}`;
    }

    protectedKey(instanceId: string): string {
        return `instance:scaleDownProtected:${instanceId}`;
    }

    async setShutdownStatus(
        ctx: Context,
        instanceDetails: Array<InstanceDetails>,
        status = 'shutdown',
    ): Promise<boolean> {
        const pipeline = this.redisClient.pipeline();
        for (const instance of instanceDetails) {
            const key = this.shutDownKey(instance.instanceId);
            ctx.logger.debug('Writing shutdown status', { key, status });
            pipeline.set(key, status, 'EX', this.shutdownTTL);
        }
        await pipeline.exec();
        await this.audit.saveShutdownEvents(instanceDetails);
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

    async getShutdownStatus(ctx: Context, instanceId: string): Promise<boolean> {
        const key = this.shutDownKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read shutdown status', { key, res });
        return res == 'shutdown';
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
