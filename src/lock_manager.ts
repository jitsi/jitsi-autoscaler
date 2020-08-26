import Redis from 'ioredis';
import Redlock from 'redlock';
import { Logger } from 'winston';
import { Context } from './context';

export interface LockManagerOptions {
    redisClient: Redis.Redis;
    autoscalerProcessingLockTTL: number;
    jobCreationLockTTL: number;
}

export default class LockManager {
    private redisClient: Redis.Redis;
    private groupProcessingLockManager: Redlock;
    private autoscalerProcessingLockTTL: number;
    private jobCreationLockTTL: number;
    private logger: Logger;
    private static readonly autoscalerProcessingLockKey = 'autoscalerLockKey';
    private static readonly scalerProcessingLockKey = 'scalerLockKey';
    private static readonly groupJobsCreationLockKey = 'groupJobsCreationLockKey';

    constructor(logger: Logger, options: LockManagerOptions) {
        this.logger = logger;
        this.redisClient = options.redisClient;
        this.autoscalerProcessingLockTTL = options.autoscalerProcessingLockTTL;
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
    }

    async lockAutoscaleProcessing(ctx: Context, group: string): Promise<Redlock.Lock> {
        ctx.logger.debug(`Obtaining lock ${LockManager.autoscalerProcessingLockKey}`);
        const lock = await this.groupProcessingLockManager.lock(
            `${LockManager.autoscalerProcessingLockKey}:${group}`,
            this.autoscalerProcessingLockTTL,
        );
        ctx.logger.debug(`Lock obtained for ${LockManager.autoscalerProcessingLockKey}`);
        return lock;
    }

    async lockJobCreation(ctx: Context): Promise<Redlock.Lock> {
        ctx.logger.debug(`Obtaining lock ${LockManager.groupJobsCreationLockKey}`);
        const lock = await this.groupProcessingLockManager.lock(
            LockManager.groupJobsCreationLockKey,
            this.jobCreationLockTTL,
        );
        ctx.logger.debug(`Lock obtained for ${LockManager.groupJobsCreationLockKey}`);
        return lock;
    }
}
