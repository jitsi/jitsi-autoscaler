import { Logger } from 'winston';
import Redlock from 'redlock';
import Redis from 'ioredis';

export enum JibriStatusState {
    Idle = 'IDLE',
    Busy = 'BUSY',
}

export enum JibriHealthState {
    Healthy = 'HEALTHY',
    Unhealthy = 'UNHEALTHY',
}

export interface JibriStatus {
    busyStatus: JibriStatusState;
    health: JibriHealth;
}

export interface JibriHealth {
    healthStatus: JibriHealthState;
}

export interface JibriState {
    jibriId: string;
    status: JibriStatus;
}

export class JibriTracker {
    private redisClient: Redis.Redis;
    private pendingLock: Redlock;
    private logger: Logger;

    static readonly idleTTL = 90; // seconds
    static readonly pendingTTL = 10000; // milliseconds

    constructor(logger: Logger, redisClient: Redis.Redis) {
        //this.setPending = this.setPending.bind(this);
        this.logger = logger;
        this.redisClient = redisClient;
        this.pendingLock = new Redlock(
            // TODO: you should have one client for each independent redis node or cluster
            [this.redisClient],
            {
                driftFactor: 0.01, // time in ms
                retryCount: 3,
                retryDelay: 200, // time in ms
                retryJitter: 200, // time in ms
            },
        );
        this.pendingLock.on('clientError', (err) => {
            this.logger.error('A pendingLock redis error has occurred:', err);
        });
    }

    async track(state: JibriState): Promise<boolean> {
        const key = `jibri:idle:${state.jibriId}`;
        if (
            state.status.busyStatus === JibriStatusState.Idle &&
            state.status.health.healthStatus === JibriHealthState.Healthy
        ) {
            const result = await this.redisClient.set(key, 1, 'ex', JibriTracker.idleTTL);
            if (result !== 'OK') {
                throw new Error(`unable to set ${key}`);
            }
            return true;
        }
        await this.redisClient.del(key);
        return false;
    }

    async setPending(key: string): Promise<boolean> {
        try {
            this.logger.debug(`attempting lock of ${key}`);
            await this.pendingLock.lock(key, JibriTracker.pendingTTL);
            this.logger.debug(`${key} lock obtained`);
            return true;
        } catch (err) {
            this.logger.warn(`error obtaining lock for ${key} - ${err}`);
            return false;
        }
    }

    async nextAvailable(): Promise<string> {
        const idle: Array<string> = [];
        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', 'jibri:idle:*');
            cursor = result[0];
            idle.push(...result[1]);
        } while (cursor != '0');
        this.logger.debug(`idle jibri: ${idle}`);

        for (const value of idle) {
            const id: string = value.split(':')[2];
            const pendingKey = `jibri:pending:${id}`;
            const locked = await this.setPending(pendingKey);
            if (locked) {
                this.logger.debug(`${id} is now pending`);
                return id;
            } else {
                continue;
            }
        }
        throw new Error('no recorder');
    }
}
