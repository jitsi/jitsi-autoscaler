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

// Bookkeeping for a lock this node currently holds, so the manager can bound how long it is held.
interface HeldConsulLock {
    key: string;
    session: string;
    acquiredAt: number;
    maxHoldMs: number;
}

export class ConsulLocker implements AutoscalerLock {
    private client: Consul;
    public session: string;
    public key: string;
    // Reports whether this locker is still the tracked holder of its key (untracking it if so). Returns
    // false when the manager force-released the key (releaseOverheldLocks) and this node has since
    // re-acquired it: every lock on a node shares one Consul session, and Consul's `?release=<session>`
    // succeeds whenever the key's session matches, so a KV release from the stale locker would strip the
    // *current* holder's lock. Absent when a locker is constructed standalone (always releases).
    private onRelease?: () => boolean;

    constructor(client: Consul, session: string, key: string, onRelease?: () => boolean) {
        this.client = client;
        this.session = session;
        this.key = key;
        this.onRelease = onRelease;
    }

    // release() is called from finally blocks, so it must never throw or it would mask the original error.
    async release(ctx: Context): Promise<void> {
        ctx.logger.debug(`Releasing consul lock ${this.key}`, { key: this.key, session: this.session });
        const isTrackedHolder = this.onRelease ? this.onRelease() : true;
        if (!isTrackedHolder) {
            ctx.logger.warn(
                `Consul lock ${this.key} was already force-released; skipping KV release so the current holder keeps it`,
                { key: this.key, session: this.session },
            );
            return;
        }
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
    // Memoizes an in-flight rotation so concurrent acquire failures rotate the session exactly once.
    private rotationPromise?: Promise<string>;
    // Consecutive renewal failures; used to keep a session alive across transient renew errors.
    private renewFailureCount = 0;
    // Monotonic token identifying the current session creation; bumped on clear/rotation to invalidate
    // an in-flight createConsulSession that has been superseded.
    private creationToken = 0;
    // Set once shutdown() runs so no new session is created (or committed) afterwards.
    private shuttingDown = false;
    // Maximum hold per lock kind (ms), the Redlock-equivalent lock TTL. Infinity when not configured.
    private groupLockMaxHoldMs: number;
    private jobCreationLockMaxHoldMs: number;
    // Locks currently held by this node, keyed by lock key. Consul locks are backed by the renewed
    // session and would otherwise be held forever by a hung job; see releaseOverheldLocks.
    private heldLocks = new Map<string, HeldConsulLock>();
    // Keys whose KV acquire is in flight on this node. Consul's acquire returns true when the key is already
    // held by the *same* session, and every lock on this node shares one session, so two local callers
    // (AUTOSCALE:G and LAUNCH:G, or a job and an HTTP handler) would both "acquire" the same group lock and
    // run unprotected. heldLocks alone can't prevent that: two callers that both pass the check before either
    // has tracked its lock would still race to KV. Reserving the key synchronously right before the KV call
    // (and checking both maps at that instant) makes the local check atomic.
    private acquiring = new Set<string>();

    private static readonly ACQUIRE_RETRY_COUNT = 3;
    private static readonly ACQUIRE_RETRY_DELAY_MS = 200;
    // Consul rejects session.create outside this TTL range; see deriveSessionTTLSeconds.
    private static readonly SESSION_TTL_MIN_SECONDS = 10;
    private static readonly SESSION_TTL_MAX_SECONDS = 86400;
    // Bounded fallback when no usable lock TTL is configured (unbounded sessions would stall a group forever).
    private static readonly DEFAULT_SESSION_TTL_SECONDS = 90;

    constructor(options: ConsulLockManagerOptions) {
        this.consulClient = options.consulClient;
        this.logger = options.logger;
        if (options.consulKeyPrefix) {
            this.consulKeyPrefix = options.consulKeyPrefix;
        }
        this.groupLockMaxHoldMs = options.groupLockTTLMs > 0 ? options.groupLockTTLMs : Infinity;
        this.jobCreationLockMaxHoldMs = options.jobCreationLockTTL > 0 ? options.jobCreationLockTTL : Infinity;
        // Derive the shared Consul session TTL from the configured lock TTLs. The session backs every
        // lock, so a crashed node holds its locks until the session TTL lapses; bounding it to the
        // configured lock TTL keeps crash-stall in the same ballpark as the Redis TTLs. Consul only accepts
        // session TTLs in [10s, 86400s]; an out-of-range value is clamped (with a warning) rather than passed
        // through, because session.create would reject it and every lock call would then throw.
        const maxTTLMs = Math.max(options.groupLockTTLMs || 0, options.jobCreationLockTTL || 0);
        this.consulSessionTTLSeconds = this.deriveSessionTTLSeconds(maxTTLMs);
        // Renew at ~1/3 of the TTL so a single missed renewal doesn't expire the session.
        this.consulSessionRenewInterval = Math.max(5000, Math.floor((this.consulSessionTTLSeconds * 1000) / 3));
    }

    private deriveSessionTTLSeconds(maxTTLMs: number): number {
        const derivedSeconds = Math.ceil(maxTTLMs / 1000);
        if (!(derivedSeconds > 0)) {
            // Nothing configured (or NaN): a deliberate default, not a misconfiguration, so no warning.
            return ConsulLockManager.DEFAULT_SESSION_TTL_SECONDS;
        }
        if (derivedSeconds < ConsulLockManager.SESSION_TTL_MIN_SECONDS) {
            this.logger?.warn(
                `Configured lock TTL (${derivedSeconds}s) is below the Consul session minimum of ${ConsulLockManager.SESSION_TTL_MIN_SECONDS}s; using ${ConsulLockManager.DEFAULT_SESSION_TTL_SECONDS}s`,
                { derivedSeconds, maxTTLMs },
            );
            return ConsulLockManager.DEFAULT_SESSION_TTL_SECONDS;
        }
        if (derivedSeconds > ConsulLockManager.SESSION_TTL_MAX_SECONDS) {
            // Covers Infinity too. Locks are still bounded by their own maxHoldMs; only the crash-stall
            // window (how long a dead node's locks linger) is capped here.
            this.logger?.warn(
                `Configured lock TTL (${derivedSeconds}s) exceeds the Consul session maximum of ${ConsulLockManager.SESSION_TTL_MAX_SECONDS}s; clamping`,
                { derivedSeconds, maxTTLMs },
            );
            return ConsulLockManager.SESSION_TTL_MAX_SECONDS;
        }
        return derivedSeconds;
    }

    async initConsulSession(): Promise<string> {
        if (this.shuttingDown) {
            throw new Error('ConsulLockManager is shutting down');
        }
        if (this.consulSession) {
            return this.consulSession;
        }
        if (!this.sessionPromise) {
            this.sessionPromise = this.createConsulSession();
        }
        return this.sessionPromise;
    }

    private async createConsulSession(): Promise<string> {
        // Token this creation so a clearSession()/rotation/shutdown that races the in-flight create can
        // invalidate it: a create must never commit (or leak) a session once it has been superseded.
        const token = ++this.creationToken;
        let created: string;
        try {
            const s = await this.consulClient.session.create({
                behavior: 'release',
                ttl: `${this.consulSessionTTLSeconds}s`,
                lockdelay: '1s',
            });
            created = s.ID;
        } catch (err) {
            // Clear the in-flight promise so the next call retries session creation.
            if (this.creationToken === token) {
                this.sessionPromise = undefined;
            }
            throw err;
        }
        if (this.shuttingDown || this.creationToken !== token) {
            // Superseded while creating. Destroy the never-committed session only when shutting down (nothing
            // holds locks under it); otherwise leave it to decay at its TTL, per the never-destroy policy.
            if (this.shuttingDown) {
                await this.destroySessionBestEffort(created);
            }
            throw new Error('consul session creation superseded');
        }
        this.consulSession = created;
        this.scheduleRenew();
        return created;
    }

    private scheduleRenew(): void {
        // Clear any pending renew timer first, so overlapping calls (a manual renew while a scheduled one is
        // still pending) can't orphan a handle or leave two renew loops running against the same session.
        if (this.consulRenewTimeout) {
            clearTimeout(this.consulRenewTimeout);
        }
        this.consulRenewTimeout = setTimeout(() => {
            // renewConsulSession handles its own errors; never let a rejection escape this bare timer.
            this.renewConsulSession().catch((err) => {
                this.logger?.error('Unexpected error renewing consul session', { err });
            });
        }, this.consulSessionRenewInterval);
        // A background renew timer must never keep the process alive on its own.
        this.consulRenewTimeout.unref?.();
    }

    async renewConsulSession(): Promise<boolean> {
        // Capture the session this renew is for. If a rotation replaces it while renew is in flight, this
        // timer is stale and must not reschedule or count failures — otherwise two renew loops run against
        // one session, double-counting failures and orphaning a timer.
        const session = this.consulSession;
        if (!session) {
            return false;
        }
        try {
            await this.consulClient.session.renew(session);
        } catch (err) {
            if (this.consulSession !== session) {
                return false; // rotated while in flight; this timer is stale
            }
            // The renew interval is ~TTL/3, so a single transient failure still leaves time to renew
            // before the TTL lapses. Only abandon the session once retries can no longer save it —
            // abandoning on the first failure would release live locks mid-job under behavior:'release'.
            this.renewFailureCount++;
            const elapsedMs = this.renewFailureCount * this.consulSessionRenewInterval;
            if (elapsedMs < this.consulSessionTTLSeconds * 1000) {
                this.logger?.warn('Failed to renew consul session, will retry before TTL lapses', {
                    err,
                    failureCount: this.renewFailureCount,
                });
                this.scheduleRenew();
                // The retries are keeping this session (and every lock under it) alive, so overheld locks must
                // stay bounded through a partial outage too. Timer is already armed, so a slow sweep is harmless.
                await this.releaseOverheldLocks();
                return false;
            }
            // Give up, but do NOT destroy: a client-side renew failure does not prove the session is dead
            // server-side (Consul invalidates TTL sessions lazily), and destroying would force-release locks
            // that in-flight jobs still hold. Just drop our reference — a dead session's locks are already
            // gone, a live one's stay held until its TTL. Destroy is only safe from shutdown().
            // Nothing renews this session any more, so every lock still held under it (in-flight jobs) lapses
            // at the TTL with no release from us. Name exactly which keys are affected, then drop them from the
            // held map: their lockers' release() will find themselves untracked and skip the KV release, which
            // is right — the session is presumed dead and the lock is already gone server-side.
            const heldKeys = Array.from(this.heldLocks.keys());
            this.logger?.error(
                'Consul session renewal exhausted, abandoning session reference; locks still held under it will lapse at its TTL without release',
                { err, session, heldKeys },
            );
            this.heldLocks.clear();
            this.clearSession();
            return false;
        }
        if (this.consulSession !== session) {
            return true; // rotated while in flight; this timer is stale, don't reschedule
        }
        this.renewFailureCount = 0;
        // Arm the next renewal BEFORE sweeping. The sweep does KV round-trips, and a slow or stalled Consul KV
        // there must not delay the renew that keeps the session (and every lock on this node) alive: with a
        // 180s TTL a sweep stall of ~120s would otherwise expire the session and release all locks.
        this.scheduleRenew();
        // Renewing the session keeps every lock under it alive indefinitely, so this is the point where a
        // lock that outlived its TTL (a hung or overrunning job) must be force-released. Redlock locks
        // simply lapse at their TTL; without this, a Consul-backed group lock would never lapse at all.
        await this.releaseOverheldLocks();
        return true;
    }

    // Force-release every held lock whose hold time exceeds its TTL-equivalent, logging an error for each.
    // Only the overheld lock is released (not the whole session), so other in-flight jobs keep their locks.
    // Returns the keys released. `now` is injectable for tests.
    async releaseOverheldLocks(now = Date.now()): Promise<string[]> {
        const released: string[] = [];
        for (const held of Array.from(this.heldLocks.values())) {
            const heldForMs = now - held.acquiredAt;
            if (heldForMs <= held.maxHoldMs) {
                continue;
            }
            this.logger?.error(`Consul lock ${held.key} held longer than its TTL, force-releasing it`, {
                key: held.key,
                session: held.session,
                heldForMs,
                maxHoldMs: held.maxHoldMs,
            });
            this.heldLocks.delete(held.key);
            try {
                const res = await this.consulClient.kv.set({ key: held.key, value: 'false', release: held.session });
                if (!res) {
                    this.logger?.warn(`Failed to force-release overheld consul lock ${held.key}`, { key: held.key });
                }
            } catch (err) {
                this.logger?.warn(`Error force-releasing overheld consul lock ${held.key}`, { key: held.key, err });
            }
            released.push(held.key);
        }
        return released;
    }

    private trackHeldLock(key: string, session: string, maxHoldMs: number): ConsulLocker {
        const held: HeldConsulLock = { key, session, acquiredAt: Date.now(), maxHoldMs };
        this.heldLocks.set(key, held);
        // Only drop this exact entry, and report whether it was still the tracked holder. If the lock was
        // force-released (releaseOverheldLocks) and re-acquired by this node in the meantime, the stale
        // locker's release() must neither untrack the new holder nor issue a KV release: all locks share one
        // session, so that release would succeed against the new holder's lock. Returning false makes the
        // locker skip the KV release. The same applies after shutdown()/renewal exhaustion cleared the map.
        return new ConsulLocker(this.consulClient, session, key, () => {
            if (this.heldLocks.get(key) !== held) {
                return false;
            }
            this.heldLocks.delete(key);
            return true;
        });
    }

    private clearSession(): void {
        this.consulSession = undefined;
        this.sessionPromise = undefined;
        this.renewFailureCount = 0;
        // Invalidate any in-flight createConsulSession so it won't commit a now-superseded session.
        this.creationToken++;
        if (this.consulRenewTimeout) {
            clearTimeout(this.consulRenewTimeout);
            this.consulRenewTimeout = undefined;
        }
    }

    // Replace the (possibly dead) session with a fresh one after an acquire error. Crucially this does NOT
    // destroy the old session: it is shared by every lock this node holds, so if it is actually still alive
    // (a transient transport blip) destroying it would release those locks mid-job. A genuinely dead session
    // has already had its locks released by Consul; either way, dropping our reference is the safe choice.
    // Memoized so concurrent acquire failures rotate exactly once.
    private async rotateSession(erredSession?: string): Promise<string> {
        // Someone already rotated away from the erred session; reuse the current one.
        if (this.consulSession && this.consulSession !== erredSession) {
            return this.consulSession;
        }
        if (!this.rotationPromise) {
            this.rotationPromise = (async () => {
                this.clearSession();
                return this.initConsulSession();
            })();
            // Clear the memo once settled so a later error can rotate again.
            const clearMemo = (): void => {
                this.rotationPromise = undefined;
            };
            this.rotationPromise.then(clearMemo, clearMemo);
        }
        return this.rotationPromise;
    }

    // Destroy a session best-effort. Only ever called for a session that nothing holds locks under: the
    // current session during shutdown(), or a never-committed session abandoned mid-creation while shutting
    // down. Rotation/renewal-exhaustion must NOT destroy — see rotateSession's rationale.
    private async destroySessionBestEffort(session?: string): Promise<void> {
        if (!session) {
            return;
        }
        try {
            await this.consulClient.session.destroy(session);
        } catch (err) {
            this.logger?.warn('Error destroying consul session', { err });
        }
    }

    async shutdown(): Promise<void> {
        // shutdown() is the only place a committed session is destroyed: nothing else holds locks under it here.
        this.shuttingDown = true;
        const session = this.consulSession;
        this.clearSession();
        this.heldLocks.clear();
        await this.destroySessionBestEffort(session);
    }

    async lockGroup(ctx: Context, group: string): Promise<AutoscalerLock> {
        // Group locks are also taken by HTTP handlers; retry on contention (parity with the Redis/Redlock
        // backend) so a routine collision with a job doesn't surface as a 500 to the API caller.
        return this.lockKey(ctx, `${this.consulKeyPrefix}/group/${group}`, true, this.groupLockMaxHoldMs);
    }

    async lockJobCreation(ctx: Context): Promise<AutoscalerLock> {
        // Job creation must have exactly one winner per cycle: retrying could let a second node acquire
        // after the winner releases and create a duplicate set of jobs. So fail fast on contention.
        return this.lockKey(ctx, `${this.consulKeyPrefix}/jobCreation`, false, this.jobCreationLockMaxHoldMs);
    }

    async lockKey(
        ctx: Context,
        key: string,
        retryOnContention = true,
        maxHoldMs = this.groupLockMaxHoldMs,
    ): Promise<AutoscalerLock> {
        let rotated = false;
        let contentionAttempts = 0;
        for (;;) {
            // Re-fetch the active session at the top of every attempt. During a retry sleep a concurrent
            // rotation/renewal-exhaustion may have replaced or abandoned the session we last used; acquiring
            // under an abandoned-but-still-alive session (nothing renews it) would let the lock silently
            // lapse at its TTL mid-job. initConsulSession returns the live session or creates a fresh one.
            // The session we successfully acquire under is the one handed to the ConsulLocker, so release()
            // always targets the correct session.
            const session = await this.initConsulSession();
            // Local re-entrancy guard, evaluated synchronously right before the KV call (no await between the
            // check and the reservation). If this node already holds the key, or another local caller is mid-
            // acquire, the KV acquire would succeed against our own session, so never issue it: treat it exactly
            // like contention with another node. A key removed by releaseOverheldLocks is no longer here, so a
            // fresh acquire after a force-release proceeds normally.
            if (this.heldLocks.has(key) || this.acquiring.has(key)) {
                ctx.logger.debug(`Consul lock ${key} is already held on this node, treating as contention`, { key });
                contentionAttempts++;
                if (!retryOnContention || contentionAttempts >= ConsulLockManager.ACQUIRE_RETRY_COUNT) {
                    throw new Error(`Failed to obtain lock for key ${key}`);
                }
                await this.delayWithJitter();
                continue;
            }
            this.acquiring.add(key);
            let lock;
            try {
                ctx.logger.debug(`Obtaining consul lock ${key}`);
                lock = await this.consulClient.kv.set({ key, value: 'true', acquire: session });
            } catch (err) {
                // Transport or dead-session error. Rotate the session once and retry; rotateSession is a
                // guarded no-op if another caller already rotated, and never destroys a possibly-live session.
                // This avoids brittle sniffing of Consul error text (which the transport often masks).
                if (!rotated) {
                    rotated = true;
                    ctx.logger.warn(`Error acquiring consul lock ${key}, rotating session and retrying`, { err });
                    await this.rotateSession(session);
                    continue;
                }
                ctx.logger.error(`Error obtaining consul lock for key ${key}`, err);
                throw err;
            } finally {
                // Runs before trackHeldLock below with no await in between, so the key is never unguarded.
                this.acquiring.delete(key);
            }
            if (lock) {
                ctx.logger.debug(`Lock obtained for consul ${key}`, { key, session });
                return this.trackHeldLock(key, session, maxHoldMs);
            }
            // Lock held by another holder. Consul's lockdelay only blocks re-acquisition after a session is
            // invalidated, not after a clean release, so a brief retry often succeeds once the holder finishes.
            contentionAttempts++;
            if (!retryOnContention || contentionAttempts >= ConsulLockManager.ACQUIRE_RETRY_COUNT) {
                throw new Error(`Failed to obtain lock for key ${key}`);
            }
            await this.delayWithJitter();
        }
    }

    private delayWithJitter(): Promise<void> {
        const delay =
            ConsulLockManager.ACQUIRE_RETRY_DELAY_MS +
            Math.floor(Math.random() * ConsulLockManager.ACQUIRE_RETRY_DELAY_MS);
        return new Promise((resolve) => setTimeout(resolve, delay));
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
