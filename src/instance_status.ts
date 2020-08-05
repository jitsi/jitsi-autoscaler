import Redis from 'ioredis';
import logger from './logger';

const ShutdownTTL = 900;

export interface InstanceDetails {
    instanceId: string;
    cloud?: string;
    region?: string;
    group?: string;
}

export class InstanceStatus {
    private redisClient: Redis.Redis;

    constructor(redisClient: Redis.Redis) {
        //this.setPending = this.setPending.bind(this);
        this.redisClient = redisClient;

        this.setShutdownStatus = this.setShutdownStatus.bind(this);
        this.getShutdownStatus = this.getShutdownStatus.bind(this);
    }

    instanceKey(details: InstanceDetails): string {
        return `instance:shutdown:${details.instanceId}`;
    }

    async setShutdownStatus(details: InstanceDetails, status = 'shutdown'): Promise<boolean> {
        const key = this.instanceKey(details);
        logger.debug('Writing shutdown status', { key, status });
        await this.redisClient.set(key, status, 'ex', ShutdownTTL);
        return true;
    }

    async getShutdownStatus(details: InstanceDetails): Promise<boolean> {
        const key = this.instanceKey(details);
        const res = await this.redisClient.get(key);
        logger.debug('Read shutdown status', { key, res });
        if (res == 'shutdown') {
            return true;
        }
        return false;
    }
}
