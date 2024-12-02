// import { Redis } from 'ioredis';
import Redis from 'ioredis';
import Redlock, { Lock, ResourceLockedError } from 'redlock';
import { Logger } from 'winston';
import { Context } from './context';
import AutoscalerLock, { AutoscalerLockManager } from './lock';

export interface LockManagerOptions {
    redisClient: Redis;
    groupLockTTLMs: number;
    jobCreationLockTTL: number;
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

export default class LockManager implements AutoscalerLockManager {
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
        ctx.logger.debug(`Obtaining lock ${LockManager.groupLockKey}`);
        const lock = await this.groupProcessingLockManager.acquire(
            [`${LockManager.groupLockKey}:${group}`],
            this.groupLockTTLMs,
        );
        ctx.logger.debug(`Lock obtained for ${LockManager.groupLockKey}`);
        return new RedLocker(lock);
    }

    async lockJobCreation(ctx: Context): Promise<AutoscalerLock> {
        ctx.logger.debug(`Obtaining lock ${LockManager.groupJobsCreationLockKey}`);
        const lock = await this.groupProcessingLockManager.acquire(
            [LockManager.groupJobsCreationLockKey],
            this.jobCreationLockTTL,
        );
        ctx.logger.debug(`Lock obtained for ${LockManager.groupJobsCreationLockKey}`);
        return new RedLocker(lock);
    }
}
