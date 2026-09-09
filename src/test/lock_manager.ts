/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { describe, mock } from 'node:test';

import { RedLocker, ConsulLocker, ConsulLockManager } from '../lock_manager';

const asLogger = new AutoscalerLogger({ logLevel: 'debug' });
const logger = asLogger.createLogger('debug');

const ctx = { logger };
ctx.logger.debug = mock.fn();
ctx.logger.warn = mock.fn();
ctx.logger.error = mock.fn();

describe('lock release safety (L4)', () => {
    test('RedLocker.release resolves even when the underlying lock rejects', async () => {
        const lock = {
            release: mock.fn(async () => {
                throw new Error('EXPECTED ERROR: lock already expired');
            }),
        };
        const locker = new RedLocker(lock);
        // must resolve, not reject, so it never masks the original error in a finally block
        await assert.doesNotReject(() => locker.release(ctx));
    });

    test('ConsulLocker.release resolves even when kv.set rejects', async () => {
        const client = {
            kv: {
                set: mock.fn(async () => {
                    throw new Error('EXPECTED ERROR: consul unavailable');
                }),
            },
        };
        const locker = new ConsulLocker(client, 'session-1', 'some/key');
        await assert.doesNotReject(() => locker.release(ctx));
    });
});

function makeConsulClient(overrides = {}) {
    let created = 0;
    return {
        session: {
            create: mock.fn(async () => ({ ID: `s${++created}` })),
            renew: mock.fn(async () => undefined),
            destroy: mock.fn(async () => undefined),
        },
        kv: { set: mock.fn(async () => true) },
        ...overrides,
    };
}

describe('ConsulLockManager acquire behavior', () => {
    // Job creation must have one winner per cycle: contention fails fast with no retry.
    test('lockJobCreation fails fast when the lock is held', async () => {
        const client = makeConsulClient();
        client.kv.set = mock.fn(async () => false);
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        await assert.rejects(() => lm.lockJobCreation(ctx), /Failed to obtain lock/);
        assert.strictEqual(client.kv.set.mock.callCount(), 1, 'job-creation contention must not be retried');
        await lm.shutdown();
    });

    // Group locks are shared with HTTP handlers: contention is retried (parity with Redlock) before failing.
    test('lockGroup retries contention then throws after the retry budget', async () => {
        const client = makeConsulClient();
        client.kv.set = mock.fn(async () => false);
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        await assert.rejects(() => lm.lockGroup(ctx, 'g'), /Failed to obtain lock/);
        assert.strictEqual(client.kv.set.mock.callCount(), 3, 'group-lock contention should retry up to 3 times');
        assert.strictEqual(client.session.create.mock.callCount(), 1, 'contention must not rotate the session');
        await lm.shutdown();
    });

    // Concurrent acquire errors must rotate the shared session exactly once (memoized rotation).
    test('concurrent acquire errors rotate the session once', async () => {
        const client = makeConsulClient();
        let calls = 0;
        client.kv.set = mock.fn(async () => {
            calls++;
            // the first acquire from each of the two concurrent callers errors (triggering rotation);
            // the retries then succeed
            if (calls <= 2) {
                throw new Error('transport blip');
            }
            return true;
        });
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        const [a, b] = await Promise.all([lm.lockKey(ctx, 'a'), lm.lockKey(ctx, 'b')]);
        assert.ok(a && b, 'both callers should acquire');
        assert.strictEqual(
            client.session.create.mock.callCount(),
            2,
            'one initial session + exactly one rotation shared by both callers',
        );
        await lm.shutdown();
    });

    test('lockGroup succeeds when a retry acquires the lock', async () => {
        const client = makeConsulClient();
        let call = 0;
        client.kv.set = mock.fn(async () => ++call >= 2);
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        const locker = await lm.lockGroup(ctx, 'g');
        assert.ok(locker, 'expect a locker once a retry acquires');
        await lm.shutdown();
    });

    // After shutdown() no new session may be created (would leak a live server-side session + renew loop).
    test('does not create a session after shutdown', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });
        await lm.shutdown();
        await assert.rejects(() => lm.lockGroup(ctx, 'g'), /shutting down/);
        assert.strictEqual(client.session.create.mock.callCount(), 0, 'no session should be created after shutdown');
    });

    // A transport error rotates the session once and retries. The old session must NOT be destroyed (it may
    // still be alive and holding other jobs' locks); the locker must carry the session that acquired the lock.
    test('lockKey rotates the session once on an acquire error, then succeeds', async () => {
        const client = makeConsulClient();
        let call = 0;
        client.kv.set = mock.fn(async () => {
            call++;
            if (call === 1) {
                throw new Error('transport blip');
            }
            return true;
        });
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        const locker = await lm.lockKey(ctx, 'k');
        assert.strictEqual(client.session.create.mock.callCount(), 2, 'session should be rotated once');
        assert.strictEqual(
            client.session.destroy.mock.callCount(),
            0,
            'rotation must not destroy a possibly-live session',
        );
        assert.strictEqual(locker.session, 's2', 'locker must carry the acquiring (rotated) session');
        await lm.shutdown();
    });
});

// Consul locks are backed by a session the manager renews forever, so unlike a Redlock lock (which lapses
// at its TTL) a hung job would hold a Consul group lock indefinitely. The manager must bound the hold.
function releaseCalls(client) {
    return client.kv.set.mock.calls.filter((c) => c.arguments[0].release !== undefined);
}

function makeLogger() {
    return { error: mock.fn(), warn: mock.fn(), info: mock.fn(), debug: mock.fn() };
}

describe('ConsulLockManager bounded lock hold', () => {
    test('a lock held longer than groupLockTTLMs is force-released with an error log', async () => {
        const client = makeConsulClient();
        const logger = { error: mock.fn(), warn: mock.fn(), info: mock.fn(), debug: mock.fn() };
        const lm = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 10000,
            jobCreationLockTTL: 30000,
            logger,
        });
        const locker = await lm.lockGroup(ctx, 'g');

        // within the TTL: nothing happens
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 5000), []);
        assert.strictEqual(releaseCalls(client).length, 0);

        // past the TTL: exactly this lock is released under the acquiring session
        const released = await lm.releaseOverheldLocks(Date.now() + 10001);
        assert.deepStrictEqual(released, [locker.key]);
        const rel = releaseCalls(client);
        assert.strictEqual(rel.length, 1);
        assert.deepStrictEqual(rel[0].arguments[0], { key: locker.key, value: 'false', release: locker.session });
        assert.strictEqual(logger.error.mock.callCount(), 1, 'an overheld lock is an error condition');

        // idempotent: a second sweep finds nothing to release
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 20000), []);
        await lm.shutdown();
    });

    test('a released lock is untracked and never force-released', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 10000, jobCreationLockTTL: 30000 });
        const locker = await lm.lockGroup(ctx, 'g');
        await locker.release(ctx);
        assert.strictEqual(releaseCalls(client).length, 1, 'the normal release');

        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 60000), []);
        assert.strictEqual(releaseCalls(client).length, 1, 'no force-release after a normal release');
        await lm.shutdown();
    });

    test('job-creation locks are bounded by jobCreationLockTTL, group locks by groupLockTTLMs', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 60000, jobCreationLockTTL: 10000 });
        await lm.lockJobCreation(ctx);
        await lm.lockGroup(ctx, 'g');

        const released = await lm.releaseOverheldLocks(Date.now() + 10001);
        assert.strictEqual(released.length, 1);
        assert.ok(released[0].endsWith('/jobCreation'), 'only the job-creation lock has exceeded its TTL');
        await lm.shutdown();
    });

    test('the session renewal tick force-releases overheld locks', async () => {
        mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
        try {
            const client = makeConsulClient();
            const lm = new ConsulLockManager({
                consulClient: client,
                groupLockTTLMs: 10000,
                jobCreationLockTTL: 30000,
            });
            const locker = await lm.lockGroup(ctx, 'g');

            // one renew tick while the lock is still within its TTL
            mock.timers.tick(5000);
            assert.strictEqual(await lm.renewConsulSession(), true);
            assert.strictEqual(releaseCalls(client).length, 0);

            // the next tick finds the lock overheld
            mock.timers.tick(6000);
            assert.strictEqual(await lm.renewConsulSession(), true);
            const rel = releaseCalls(client);
            assert.strictEqual(rel.length, 1);
            assert.strictEqual(rel[0].arguments[0].key, locker.key);
            await lm.shutdown();
        } finally {
            mock.timers.reset();
        }
    });

    test('locks are unbounded when no TTLs are configured', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client });
        await lm.lockGroup(ctx, 'g');
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 365 * 24 * 3600 * 1000), []);
        await lm.shutdown();
    });
});

describe('ConsulLockManager session renewal', () => {
    test('a transient renew failure retains the session and reschedules', async () => {
        const client = makeConsulClient();
        client.session.renew = mock.fn(async () => {
            throw new Error('transient');
        });
        // small TTL so the renew interval is short and a single failure is well within TTL
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 90000, jobCreationLockTTL: 30000 });
        await lm.initConsulSession();

        const retained = await lm.renewConsulSession();
        assert.strictEqual(retained, false, 'renew reports failure');
        assert.strictEqual(
            client.session.destroy.mock.callCount(),
            0,
            'transient failure must not destroy the session',
        );
        await lm.shutdown();
    });

    test('renewal exhaustion drops the session reference without destroying it', async () => {
        const client = makeConsulClient();
        client.session.renew = mock.fn(async () => {
            throw new Error('down');
        });
        // TTL 10s, renew interval 5s -> exhausts after 2 failures, and the exhausting call clears the
        // tracked retry timer, so no timers are left dangling after the test.
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 10000, jobCreationLockTTL: 10000 });
        await lm.initConsulSession();

        // drive failures until the elapsed estimate passes the TTL
        for (let i = 0; i < 3; i++) {
            await lm.renewConsulSession();
        }
        assert.strictEqual(
            client.session.destroy.mock.callCount(),
            0,
            'exhaustion must not destroy a possibly-live session',
        );
        await lm.shutdown();
    });
});

// L2: the shared Consul session TTL must be derived from the configured lock TTLs (the options used to be
// accepted and ignored, leaving a hardcoded 1h session that stalled a group for up to an hour after a crash).
describe('ConsulLockManager session TTL derivation (L2)', () => {
    test('derives the session TTL from the largest configured lock TTL and renews at a third of it', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });
        await lm.initConsulSession();

        assert.strictEqual(client.session.create.mock.callCount(), 1);
        const args = client.session.create.mock.calls[0].arguments[0];
        assert.strictEqual(args.ttl, '180s', 'session TTL must equal max(groupLockTTLMs, jobCreationLockTTL)');
        assert.strictEqual(args.behavior, 'release', 'locks must be released (not deleted) when the session lapses');
        assert.strictEqual(lm.consulSessionRenewInterval, 60000, 'renew at TTL/3');
        await lm.shutdown();
    });

    test('uses jobCreationLockTTL when it is the larger of the two', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 20000, jobCreationLockTTL: 45000 });
        await lm.initConsulSession();
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '45s');
        assert.strictEqual(lm.consulSessionRenewInterval, 15000);
        await lm.shutdown();
    });

    test('falls back to a bounded 90s session when no lock TTLs are configured', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client });
        await lm.initConsulSession();
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '90s');
        assert.strictEqual(lm.consulSessionRenewInterval, 30000);
        await lm.shutdown();
    });

    test('falls back to 90s when the configured TTL is below the Consul 10s minimum', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 3000, jobCreationLockTTL: 1000 });
        await lm.initConsulSession();
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '90s');
        await lm.shutdown();
    });

    test('never renews faster than every 5s', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 10000, jobCreationLockTTL: 10000 });
        await lm.initConsulSession();
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '10s');
        assert.strictEqual(lm.consulSessionRenewInterval, 5000, 'TTL/3 would be 3.3s; floor is 5s');
        await lm.shutdown();
    });
});

// L3: first-time session creation must be memoized so concurrent lockKey() calls share one session
// (previously each created its own; the loser's session and renew timer leaked).
describe('ConsulLockManager session creation memoization (L3)', () => {
    test('concurrent first-time lockKey calls create exactly one session', async () => {
        const client = makeConsulClient();
        // slow creation so both callers are in flight before either commits
        client.session.create = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { ID: 's1' };
        });
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        const [a, b, c] = await Promise.all([lm.lockKey(ctx, 'a'), lm.lockKey(ctx, 'b'), lm.lockGroup(ctx, 'g')]);
        assert.ok(a && b && c, 'all callers should acquire');
        assert.strictEqual(client.session.create.mock.callCount(), 1, 'concurrent callers must share one session');
        assert.strictEqual(a.session, 's1');
        assert.strictEqual(b.session, 's1');
        assert.strictEqual(c.session, 's1');
        await lm.shutdown();
        assert.strictEqual(client.session.destroy.mock.callCount(), 1, 'shutdown destroys the single session');
    });

    test('a failed session creation clears the memo so the next call retries', async () => {
        const client = makeConsulClient();
        let attempts = 0;
        client.session.create = mock.fn(async () => {
            if (++attempts === 1) {
                throw new Error('consul down');
            }
            return { ID: `s${attempts}` };
        });
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        await assert.rejects(() => lm.lockKey(ctx, 'a'), /consul down/, 'the first call surfaces the failure');
        const locker = await lm.lockKey(ctx, 'a');
        assert.strictEqual(client.session.create.mock.callCount(), 2, 'the memoized failure must not be sticky');
        assert.strictEqual(locker.session, 's2');
        await lm.shutdown();
    });

    test('concurrent callers all see the same creation failure and the next call recovers', async () => {
        const client = makeConsulClient();
        let attempts = 0;
        client.session.create = mock.fn(async () => {
            attempts++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (attempts === 1) {
                throw new Error('consul down');
            }
            return { ID: `s${attempts}` };
        });
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        const results = await Promise.allSettled([lm.lockKey(ctx, 'a'), lm.lockKey(ctx, 'b')]);
        assert.deepEqual(
            results.map((r) => r.status),
            ['rejected', 'rejected'],
        );
        assert.strictEqual(client.session.create.mock.callCount(), 1, 'one shared create attempt for both callers');

        const locker = await lm.lockKey(ctx, 'a');
        assert.strictEqual(locker.session, 's2');
        assert.strictEqual(client.session.create.mock.callCount(), 2);
        await lm.shutdown();
    });
});

// Every lock on a node shares one Consul session, and Consul's `?release=<session>` succeeds whenever the
// key's session matches. So once releaseOverheldLocks() force-released a key and this node re-acquired it
// under the same session, the original (hung) job's `finally { lock.release() }` would strip the live job's
// lock unless the stale locker knows it is no longer the holder.
describe('ConsulLockManager stale release after force-release', () => {
    test('a stale release after a force-release does not strip the new holder', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 10000, jobCreationLockTTL: 30000 });
        const a = await lm.lockGroup(ctx, 'g');

        // the hung job's lock is force-released by the sweep
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 10001), [a.key]);
        assert.strictEqual(releaseCalls(client).length, 1, 'the force-release');

        // a new job on this node re-acquires the same key under the same session
        const b = await lm.lockGroup(ctx, 'g');
        assert.strictEqual(b.key, a.key);
        assert.strictEqual(b.session, a.session, 'same shared session, so a KV release from A would hit B');

        // the hung job finally finishes: its release must not touch KV
        ctx.logger.warn.mock.resetCalls();
        await a.release(ctx);
        assert.strictEqual(releaseCalls(client).length, 1, 'stale release must not issue a KV release');
        assert.ok(
            ctx.logger.warn.mock.calls.some((c) => /force-released; skipping KV release/.test(c.arguments[0])),
            'stale release is logged at warn',
        );
        // ...and B is still tracked (a later sweep would still bound it)
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 5000), []);

        // the live holder's release still works
        await b.release(ctx);
        const rel = releaseCalls(client);
        assert.strictEqual(rel.length, 2);
        assert.deepStrictEqual(rel[1].arguments[0], { key: b.key, value: 'false', release: b.session });
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 60000), [], 'B is untracked');
        await lm.shutdown();
    });

    test('a normal release hits KV exactly once and untracks the lock', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 10000, jobCreationLockTTL: 30000 });
        const locker = await lm.lockGroup(ctx, 'g');

        ctx.logger.warn.mock.resetCalls();
        await locker.release(ctx);
        const rel = releaseCalls(client);
        assert.strictEqual(rel.length, 1);
        assert.deepStrictEqual(rel[0].arguments[0], { key: locker.key, value: 'false', release: locker.session });
        assert.strictEqual(ctx.logger.warn.mock.callCount(), 0, 'a normal release is not a warning');
        assert.strictEqual(lm.heldLocks.size, 0, 'released lock is untracked');
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 60000), []);

        // a double release is a no-op against KV (the locker is no longer the tracked holder)
        await locker.release(ctx);
        assert.strictEqual(releaseCalls(client).length, 1, 'double release must not hit KV again');
        await lm.shutdown();
    });

    test('a standalone ConsulLocker (no manager) always releases', async () => {
        const client = makeConsulClient();
        const locker = new ConsulLocker(client, 's1', 'k');
        await locker.release(ctx);
        assert.strictEqual(releaseCalls(client).length, 1);
    });
});

// The renewal tick is the only thing keeping the shared session alive. The overheld-lock sweep it runs does
// KV round-trips, so it must never sit between a successful renew and re-arming the next one: with a 180s TTL
// a sweep stalled on a slow Consul KV for ~120s would expire the session and release every lock on the node.
describe('ConsulLockManager renewal ordering', () => {
    test('the next renew is armed before the overheld sweep, so a hung sweep cannot stall renewal', async () => {
        mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
        try {
            const client = makeConsulClient();
            const lm = new ConsulLockManager({
                consulClient: client,
                groupLockTTLMs: 10000,
                jobCreationLockTTL: 30000,
            });
            await lm.lockGroup(ctx, 'g');
            const schedule = mock.method(lm, 'scheduleRenew');

            // the force-release in the sweep hangs forever (Consul KV stalled)
            client.kv.set = mock.fn(() => new Promise(() => undefined));
            mock.timers.tick(10001);
            // intentionally not awaited: it cannot settle while the sweep hangs
            lm.renewConsulSession().catch(() => undefined);
            await new Promise((resolve) => setImmediate(resolve));

            assert.strictEqual(client.kv.set.mock.callCount(), 1, 'the sweep did start the force-release');
            assert.strictEqual(schedule.mock.callCount(), 1, 'the next renew must already be armed');
            await lm.shutdown();
        } finally {
            mock.timers.reset();
        }
    });

    test('a transient renew failure re-arms the timer first and then still sweeps overheld locks', async () => {
        mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
        try {
            const client = makeConsulClient();
            client.session.renew = mock.fn(async () => {
                throw new Error('transient');
            });
            // session TTL 90s / renew every 30s: one failure is well within the retry budget; group hold is 10s
            const lm = new ConsulLockManager({
                consulClient: client,
                groupLockTTLMs: 10000,
                jobCreationLockTTL: 90000,
            });
            const locker = await lm.lockGroup(ctx, 'g');

            const order = [];
            const proto = Object.getPrototypeOf(lm);
            mock.method(lm, 'scheduleRenew', () => {
                order.push('schedule');
                proto.scheduleRenew.call(lm);
            });
            client.kv.set = mock.fn(async (args) => {
                if (args.release !== undefined) {
                    order.push(`release:${args.key}`);
                }
                return true;
            });

            mock.timers.tick(10001);
            assert.strictEqual(await lm.renewConsulSession(), false, 'renew reports the transient failure');
            assert.deepStrictEqual(order, ['schedule', `release:${locker.key}`]);
            assert.strictEqual(client.session.destroy.mock.callCount(), 0, 'session is retained');
            await lm.shutdown();
        } finally {
            mock.timers.reset();
        }
    });
});

// Consul only accepts session TTLs in [10s, 86400s]; passing a larger value makes session.create reject and
// every lock call throw. The derived TTL must be clamped at both ends, with a warning.
describe('ConsulLockManager session TTL clamping', () => {
    test('clamps a lock TTL above 24h to the Consul 86400s maximum with a warning', async () => {
        const client = makeConsulClient();
        const logger = makeLogger();
        const lm = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 25 * 3600 * 1000,
            jobCreationLockTTL: 30000,
            logger,
        });
        await lm.initConsulSession();
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '86400s');
        assert.strictEqual(lm.consulSessionRenewInterval, 28_800_000, 'renew at TTL/3');
        assert.strictEqual(logger.warn.mock.callCount(), 1, 'clamping is a misconfiguration warning');
        assert.match(logger.warn.mock.calls[0].arguments[0], /exceeds the Consul session maximum of 86400s/);
        await lm.shutdown();
    });

    test('exactly 86400s is accepted without clamping or warning', async () => {
        const client = makeConsulClient();
        const logger = makeLogger();
        const lm = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 86_400_000,
            jobCreationLockTTL: 30000,
            logger,
        });
        await lm.initConsulSession();
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '86400s');
        assert.strictEqual(logger.warn.mock.callCount(), 0);
        await lm.shutdown();
    });

    test('a lock TTL below the Consul 10s minimum warns and stays within bounds', async () => {
        const client = makeConsulClient();
        const logger = makeLogger();
        const lm = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 3000,
            jobCreationLockTTL: 1000,
            logger,
        });
        await lm.initConsulSession();
        // the existing 90s fallback (pinned by the L2 suite) is inside [10s, 86400s]
        assert.strictEqual(client.session.create.mock.calls[0].arguments[0].ttl, '90s');
        assert.strictEqual(logger.warn.mock.callCount(), 1);
        assert.match(logger.warn.mock.calls[0].arguments[0], /below the Consul session minimum of 10s/);
        await lm.shutdown();
    });

    test('in-range and unconfigured TTLs do not warn', async () => {
        const client = makeConsulClient();
        const logger = makeLogger();
        const inRange = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 180000,
            jobCreationLockTTL: 30000,
            logger,
        });
        const unconfigured = new ConsulLockManager({ consulClient: client, logger });
        assert.strictEqual(inRange.consulSessionTTLSeconds, 180);
        assert.strictEqual(unconfigured.consulSessionTTLSeconds, 90);
        assert.strictEqual(logger.warn.mock.callCount(), 0);
        await inRange.shutdown();
        await unconfigured.shutdown();
    });
});

// When renewal is exhausted the session reference is dropped and nothing renews it any more, so every lock
// still held under it (in-flight jobs) lapses silently at the TTL. The operator must be told which keys.
describe('ConsulLockManager renewal exhaustion held-lock reporting', () => {
    test('renewal exhaustion logs the keys still held and untracks them', async () => {
        const client = makeConsulClient();
        client.session.renew = mock.fn(async () => {
            throw new Error('down');
        });
        const logger = makeLogger();
        // TTL 10s, renew interval 5s -> exhausts on the 2nd consecutive failure
        const lm = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 10000,
            jobCreationLockTTL: 10000,
            logger,
        });
        const g = await lm.lockGroup(ctx, 'g');
        const j = await lm.lockJobCreation(ctx);

        await lm.renewConsulSession();
        assert.strictEqual(logger.error.mock.callCount(), 0, 'first failure is transient');
        assert.strictEqual(lm.heldLocks.size, 2, 'locks stay tracked while retries can still save the session');

        await lm.renewConsulSession();
        const exhausted = logger.error.mock.calls.find((c) => c.arguments[1]?.heldKeys !== undefined);
        assert.ok(exhausted, 'exhaustion error must carry the held keys');
        assert.deepStrictEqual(exhausted.arguments[1].heldKeys.sort(), [g.key, j.key].sort());
        assert.strictEqual(exhausted.arguments[1].session, 's1');
        assert.strictEqual(lm.heldLocks.size, 0, 'nothing renews that session any more, so nothing is tracked');
        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 60000), []);
        assert.strictEqual(client.session.destroy.mock.callCount(), 0, 'still never destroyed');
        await lm.shutdown();
    });

    test('renewal exhaustion with no held locks logs an empty key list', async () => {
        const client = makeConsulClient();
        client.session.renew = mock.fn(async () => {
            throw new Error('down');
        });
        const logger = makeLogger();
        const lm = new ConsulLockManager({
            consulClient: client,
            groupLockTTLMs: 10000,
            jobCreationLockTTL: 10000,
            logger,
        });
        await lm.initConsulSession();
        await lm.renewConsulSession();
        await lm.renewConsulSession();
        assert.strictEqual(logger.error.mock.callCount(), 1);
        assert.deepStrictEqual(logger.error.mock.calls[0].arguments[1].heldKeys, []);
        await lm.shutdown();
    });
});

// Consul's acquire returns true when the key is already held by the *same* session, and every lock on a node
// shares one session. Without a local guard, two concurrent jobs on one node (AUTOSCALE:G and LAUNCH:G, or a
// job and an HTTP handler) would both "acquire" the same group lock and run unprotected.
describe('ConsulLockManager same-session double acquire', () => {
    function acquireCalls(client) {
        return client.kv.set.mock.calls.filter((c) => c.arguments[0].acquire !== undefined);
    }

    test('a concurrent lockGroup for a key this node already holds is treated as contention', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        const [first, second] = await Promise.allSettled([lm.lockGroup(ctx, 'g'), lm.lockGroup(ctx, 'g')]);
        assert.strictEqual(first.status, 'fulfilled', 'the first caller holds the lock');
        assert.strictEqual(second.status, 'rejected', 'the second caller must not also acquire');
        assert.match(second.reason.message, /Failed to obtain lock/, 'same error as inter-node contention');
        assert.strictEqual(acquireCalls(client).length, 1, 'the KV acquire must never be issued for the second');
        assert.strictEqual(lm.heldLocks.size, 1);
        await lm.shutdown();
    });

    test('once the local holder releases, a waiting lockGroup acquires on retry', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });
        const a = await lm.lockGroup(ctx, 'g');

        // the second caller starts while A holds the lock; A releases before the first retry (>= 200ms)
        const pending = lm.lockGroup(ctx, 'g');
        await new Promise((resolve) => setTimeout(resolve, 50));
        await a.release(ctx);
        const b = await pending;

        assert.strictEqual(b.key, a.key);
        assert.strictEqual(acquireCalls(client).length, 2, "A's acquire and B's successful retry");
        assert.strictEqual(lm.heldLocks.size, 1, 'B is now the tracked holder');
        await b.release(ctx);
        assert.strictEqual(lm.heldLocks.size, 0);
        await lm.shutdown();
    });

    test('lockJobCreation while already held locally fails fast with no KV call', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });
        const first = await lm.lockJobCreation(ctx);

        await assert.rejects(() => lm.lockJobCreation(ctx), /Failed to obtain lock/);
        assert.strictEqual(acquireCalls(client).length, 1, 'no second KV acquire');
        await first.release(ctx);
        await lm.shutdown();
    });

    test('after a force-release, re-acquiring the same key on this node succeeds', async () => {
        const client = makeConsulClient();
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 10000, jobCreationLockTTL: 30000 });
        const a = await lm.lockGroup(ctx, 'g');

        assert.deepStrictEqual(await lm.releaseOverheldLocks(Date.now() + 10001), [a.key]);
        const b = await lm.lockGroup(ctx, 'g');
        assert.strictEqual(b.key, a.key);
        assert.strictEqual(acquireCalls(client).length, 2, 'the re-acquire went to KV');
        assert.strictEqual(lm.heldLocks.size, 1);
        await b.release(ctx);
        await lm.shutdown();
    });
});
