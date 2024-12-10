// import { Redis } from 'ioredis';
import Redis from 'ioredis';
import Consul from 'consul';
import Redlock, { Lock, ResourceLockedError } from 'redlock';
import { Logger } from 'winston';
import { Context } from './context';
import AutoscalerLock, { AutoscalerLockManager } from './lock';

export interface LockManagerOptions {
    redisClient?: Redis;
    groupLockTTLMs: number;
    jobCreationLockTTL: number;
}

export interface ConsulLockManagerOptions {
    consulClient: Consul;
    groupLockTTLMs: number;
    jobCreationLockTTL: number;
    consulKeyPrefix?: string;
}

export class ConsulLocker implements AutoscalerLock {
    private client: Consul;
    public session: string;
    public key: string;

    constructor(client: Consul, session: string, key: string) {
        this.client = client;
        this.session = session;
        this.key = key;
    }
    async release(): Promise<void> {
        this.client.kv.set({ key: this.key, value: 'false', release: this.session });
    }
}

export class RedLocker implements AutoscalerLock {
    private lock: Lock;
    constructor(lock: Lock) {
        this.lock = lock;
    }
    async release(): Promise<void> {
        await this.lock.release();
    }
}

export class ConsulLockManager implements AutoscalerLockManager {
    private consulClient: Consul;
    private consulSession: string;
    private consulSessionTTL = '1h';
    private consulKeyPrefix = 'autoscaler/locks';
    // 30 minutes
    private consulSessionRenewInterval = 30 * 60 * 1000;

    private consulRenewTimeout: NodeJS.Timeout;

    constructor(options: ConsulLockManagerOptions) {
        this.consulClient = options.consulClient;
        if (options.consulKeyPrefix) {
            this.consulKeyPrefix = options.consulKeyPrefix;
        }
    }

    async initConsulSession(): Promise<void> {
        if (!this.consulSession) {
            const s = await this.consulClient.session.create({
                behavior: 'release',
                ttl: this.consulSessionTTL,
                lockdelay: '1s',
            });
            this.consulSession = s.ID;
            this.consulRenewTimeout = setTimeout(() => {
                this.renewConsulSession();
            }, this.consulSessionRenewInterval);
        }
    }

    async renewConsulSession(): Promise<boolean> {
        if (this.consulSession) {
            await this.consulClient.session.renew(this.consulSession);
            // schedule the next renewal
            this.consulRenewTimeout = setTimeout(() => {
                this.renewConsulSession();
            }, this.consulSessionRenewInterval);
            return true;
        } else {
            return false;
        }
    }

    async shutdown(): Promise<void> {
        if (this.consulSession) {
            await this.consulClient.session.destroy(this.consulSession);
        }
        if (this.consulRenewTimeout) {
            clearTimeout(this.consulRenewTimeout);
        }
    }

    async lockGroup(ctx: Context, group: string): Promise<AutoscalerLock> {
        const lockKey = `${this.consulKeyPrefix}/group/${group}`;
        return this.lockKey(ctx, lockKey);
    }

    async lockKey(ctx: Context, key: string): Promise<AutoscalerLock> {
        await this.initConsulSession();
        try {
            ctx.logger.debug(`Obtaining consul lock ${key}`);
            const lock = await this.consulClient.kv.set({ key, value: 'true', acquire: this.consulSession });
            if (!lock) {
                throw new Error(`Failed to obtain lock for key ${key}`);
            }
            ctx.logger.debug(`Lock obtained for consul ${key}`);
            return new ConsulLocker(this.consulClient, this.consulSession, key);
        } catch (err) {
            ctx.logger.error(`Error obtaining consul lock for key ${key}`, err);
            throw err;
        }
    }

    async lockJobCreation(ctx: Context): Promise<AutoscalerLock> {
        const lockKey = `${this.consulKeyPrefix}/jobCreation`;
        return this.lockKey(ctx, lockKey);
    }
}

export class RedisLockManager implements AutoscalerLockManager {
    private redisClient: Redis;
    private groupProcessingLockManager: Redlock;
    private groupLockTTLMs: number;
    private jobCreationLockTTL: number;
    private logger: Logger;
    private static readonly groupLockKey = 'groupLockKey';
    private static readonly groupJobsCreationLockKey = 'groupJobsCreationLockKey';

    constructor(logger: Logger, options: LockManagerOptions) {
        this.logger = logger;
        this.redisClient = options.redisClient;
        this.groupLockTTLMs = options.groupLockTTLMs;
        this.jobCreationLockTTL = options.jobCreationLockTTL;
        this.groupProcessingLockManager = new Redlock(
            // TODO: you should have one client for each independent redis node or cluster
            [this.redisClient],
            {
                driftFactor: 0.01, // time in ms
                retryCount: 3,
                retryDelay: 200, // time in ms
                retryJitter: 200, // time in ms
            },
        );
        this.groupProcessingLockManager.on('clientError', (err) => {
            this.logger.error('A redis error has occurred on the autoscalerLock:', err);
        });
        this.groupProcessingLockManager.on('error', (err) => {
            // Ignore cases where a resource is explicitly marked as locked on a client.
            if (err instanceof ResourceLockedError) {
                return;
            }

            this.logger.error('A redis error has occurred on the autoscalerLock:', err);
        });
    }

    async lockGroup(ctx: Context, group: string): Promise<AutoscalerLock> {
        ctx.logger.debug(`Obtaining lock ${RedisLockManager.groupLockKey}`);
        const lock = await this.groupProcessingLockManager.acquire(
            [`${RedisLockManager.groupLockKey}:${group}`],
            this.groupLockTTLMs,
        );
        ctx.logger.debug(`Lock obtained for ${RedisLockManager.groupLockKey}`);
        return new RedLocker(lock);
    }

    async lockJobCreation(ctx: Context): Promise<AutoscalerLock> {
        ctx.logger.debug(`Obtaining lock ${RedisLockManager.groupJobsCreationLockKey}`);
        const lock = await this.groupProcessingLockManager.acquire(
            [RedisLockManager.groupJobsCreationLockKey],
            this.jobCreationLockTTL,
        );
        ctx.logger.debug(`Lock obtained for ${RedisLockManager.groupJobsCreationLockKey}`);
        return new RedLocker(lock);
    }
}
