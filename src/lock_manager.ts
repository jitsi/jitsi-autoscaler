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
    logger?: Logger;
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

    // release() is called from finally blocks, so it must never throw or it would mask the original error.
    async release(ctx: Context): Promise<void> {
        ctx.logger.debug(`Releasing consul lock ${this.key}`, { key: this.key, session: this.session });
        try {
            const res = await this.client.kv.set({ key: this.key, value: 'false', release: this.session });
            if (!res) {
                ctx.logger.warn(`Failed to release consul lock ${this.key}`, { key: this.key, session: this.session });
            }
        } catch (err) {
            ctx.logger.warn(`Error releasing consul lock ${this.key}`, { key: this.key, session: this.session, err });
        }
    }
}

export class RedLocker implements AutoscalerLock {
    private lock: Lock;
    constructor(lock: Lock) {
        this.lock = lock;
    }

    // release() is called from finally blocks, so it must never throw. A redlock whose TTL has already
    // expired (job overran its lock) rejects on release; that is expected, so log at warn and swallow.
    async release(ctx: Context): Promise<void> {
        ctx.logger.debug('Releasing lock');
        try {
            await this.lock.release();
        } catch (err) {
            ctx.logger.warn('Error releasing redis lock (the lock may have already expired)', { err });
        }
    }
}

export class ConsulLockManager implements AutoscalerLockManager {
    private consulClient: Consul;
    private consulSession: string;
    private consulKeyPrefix = 'autoscaler/locks';
    private consulSessionTTLSeconds: number;
    private consulSessionRenewInterval: number;
    private logger?: Logger;

    private consulRenewTimeout: NodeJS.Timeout;
    // Memoizes an in-flight session creation so concurrent lockKey() calls don't each create (and leak) a session.
    private sessionPromise?: Promise<string>;

    private static readonly ACQUIRE_RETRY_COUNT = 3;
    private static readonly ACQUIRE_RETRY_DELAY_MS = 200;

    constructor(options: ConsulLockManagerOptions) {
        this.consulClient = options.consulClient;
        this.logger = options.logger;
        if (options.consulKeyPrefix) {
            this.consulKeyPrefix = options.consulKeyPrefix;
        }
        // Derive the shared Consul session TTL from the configured lock TTLs. The session backs every
        // lock, so a crashed node holds its locks until the session TTL lapses; bounding it to the
        // configured lock TTL keeps crash-stall in the same ballpark as the Redis TTLs. Consul enforces
        // a 10s minimum session TTL.
        const maxTTLMs = Math.max(options.groupLockTTLMs || 0, options.jobCreationLockTTL || 0);
        const derivedSeconds = Math.ceil(maxTTLMs / 1000);
        this.consulSessionTTLSeconds = Number.isFinite(derivedSeconds) && derivedSeconds >= 10 ? derivedSeconds : 90;
        // Renew at ~1/3 of the TTL so a single missed renewal doesn't expire the session.
        this.consulSessionRenewInterval = Math.max(5000, Math.floor((this.consulSessionTTLSeconds * 1000) / 3));
    }

    async initConsulSession(): Promise<string> {
        if (this.consulSession) {
            return this.consulSession;
        }
        if (!this.sessionPromise) {
            this.sessionPromise = this.createConsulSession();
        }
        return this.sessionPromise;
    }

    private async createConsulSession(): Promise<string> {
        try {
            const s = await this.consulClient.session.create({
                behavior: 'release',
                ttl: `${this.consulSessionTTLSeconds}s`,
                lockdelay: '1s',
            });
            this.consulSession = s.ID;
            this.scheduleRenew();
            return s.ID;
        } catch (err) {
            // Clear the in-flight promise so the next call retries session creation.
            this.sessionPromise = undefined;
            throw err;
        }
    }

    private scheduleRenew(): void {
        this.consulRenewTimeout = setTimeout(() => {
            // renewConsulSession handles its own errors; never let a rejection escape this bare timer.
            this.renewConsulSession().catch((err) => {
                this.logger?.error('Unexpected error renewing consul session', { err });
            });
        }, this.consulSessionRenewInterval);
    }

    async renewConsulSession(): Promise<boolean> {
        if (!this.consulSession) {
            return false;
        }
        try {
            await this.consulClient.session.renew(this.consulSession);
            // schedule the next renewal
            this.scheduleRenew();
            return true;
        } catch (err) {
            // A failed renewal means the session is likely dead. Drop it so the next lockKey() creates a
            // fresh one, rather than reusing a dead session id forever (which would fail every future lock).
            this.logger?.error('Failed to renew consul session, clearing it', { err });
            this.clearSession();
            return false;
        }
    }

    private clearSession(): void {
        this.consulSession = undefined;
        this.sessionPromise = undefined;
        if (this.consulRenewTimeout) {
            clearTimeout(this.consulRenewTimeout);
            this.consulRenewTimeout = undefined;
        }
    }

    private isInvalidSessionError(err: unknown): boolean {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        return (
            msg.includes('session') &&
            (msg.includes('invalid') ||
                msg.includes('not found') ||
                msg.includes('does not exist') ||
                msg.includes('expired'))
        );
    }

    private delayWithJitter(): Promise<void> {
        const delay =
            ConsulLockManager.ACQUIRE_RETRY_DELAY_MS +
            Math.floor(Math.random() * ConsulLockManager.ACQUIRE_RETRY_DELAY_MS);
        return new Promise((resolve) => setTimeout(resolve, delay));
    }

    async shutdown(): Promise<void> {
        if (this.consulSession) {
            try {
                await this.consulClient.session.destroy(this.consulSession);
            } catch (err) {
                this.logger?.warn('Error destroying consul session on shutdown', { err });
            }
        }
        this.clearSession();
    }

    async lockGroup(ctx: Context, group: string): Promise<AutoscalerLock> {
        const lockKey = `${this.consulKeyPrefix}/group/${group}`;
        return this.lockKey(ctx, lockKey);
    }

    async lockKey(ctx: Context, key: string): Promise<AutoscalerLock> {
        await this.initConsulSession();
        let lastErr: unknown;
        let recoveredSession = false;
        for (let attempt = 0; attempt < ConsulLockManager.ACQUIRE_RETRY_COUNT; attempt++) {
            try {
                ctx.logger.debug(`Obtaining consul lock ${key}`, { attempt });
                const lock = await this.consulClient.kv.set({ key, value: 'true', acquire: this.consulSession });
                if (!lock) {
                    throw new Error(`Failed to obtain lock for key ${key}`);
                }
                ctx.logger.debug(`Lock obtained for consul ${key}`, { key, session: this.consulSession });
                return new ConsulLocker(this.consulClient, this.consulSession, key);
            } catch (err) {
                lastErr = err;
                // Recover once from a dead/invalid session by re-initializing a fresh session and retrying.
                if (!recoveredSession && this.isInvalidSessionError(err)) {
                    recoveredSession = true;
                    ctx.logger.warn(`Consul session invalid while locking ${key}, re-initializing session`, { err });
                    this.clearSession();
                    await this.initConsulSession();
                    continue;
                }
                if (attempt < ConsulLockManager.ACQUIRE_RETRY_COUNT - 1) {
                    ctx.logger.debug(`Failed to obtain consul lock ${key}, retrying`, { attempt, err });
                    await this.delayWithJitter();
                }
            }
        }
        ctx.logger.error(`Error obtaining consul lock for key ${key}`, lastErr);
        throw lastErr;
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

    async shutdown(): Promise<void> {
        await this.groupProcessingLockManager.quit();
    }
}
