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
        if (res == 'shutdown') {
            return true;
        }
        return false;
    }
}
