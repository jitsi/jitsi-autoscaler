import Redis from 'ioredis';
import { Context } from './context';
import { InstanceDetails } from './instance_status';

export interface ShutdownManagerOptions {
    redisClient: Redis.Redis;
    shutdownTTL: number;
}

export default class ShutdownManager {
    private redisClient: Redis.Redis;
    private shutdownTTL: number;

    constructor(options: ShutdownManagerOptions) {
        this.redisClient = options.redisClient;
        this.shutdownTTL = options.shutdownTTL;
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
        return true;
    }

    async getShutdownStatus(ctx: Context, details: InstanceDetails): Promise<boolean> {
        const key = this.shutDownKey(details.instanceId);
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
