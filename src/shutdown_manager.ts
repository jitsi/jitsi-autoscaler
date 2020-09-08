import Redis from 'ioredis';
import { Context } from './context';
import Audit from './audit';
import { InstanceDetails } from './instance_tracker';

export interface ShutdownManagerOptions {
    redisClient: Redis.Redis;
    shutdownTTL: number;
    audit: Audit;
}

export default class ShutdownManager {
    private redisClient: Redis.Redis;
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

    async setShutdownStatus(ctx: Context, details: InstanceDetails, status = 'shutdown'): Promise<boolean> {
        const key = this.shutDownKey(details.instanceId);
        ctx.logger.debug('Writing shutdown status', { key, status });
        await this.redisClient.set(key, status, 'ex', this.shutdownTTL);
        await this.audit.saveShutdownEvent(details.group, details.instanceId);
        return true;
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
        await this.redisClient.set(key, mode, 'ex', protectedTTL);
        return true;
    }

    async isScaleDownProtected(ctx: Context, instanceId: string): Promise<boolean> {
        const key = this.protectedKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read protected mode', { key, res });
        return res == 'isScaleDownProtected';
    }
}
