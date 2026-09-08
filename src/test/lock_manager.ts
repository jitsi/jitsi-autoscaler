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
describe('ConsulLockManager bounded lock hold', () => {
    function releaseCalls(client) {
        return client.kv.set.mock.calls.filter((c) => c.arguments[0].release !== undefined);
    }

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
