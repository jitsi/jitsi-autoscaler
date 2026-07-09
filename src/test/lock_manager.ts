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
