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
    // L9: legitimate contention (kv.set resolves false) must fail fast with no retry / no session rotation
    test('lockKey fails fast when the lock is held', async () => {
        const client = makeConsulClient();
        client.kv.set = mock.fn(async () => false);
        const lm = new ConsulLockManager({ consulClient: client, groupLockTTLMs: 180000, jobCreationLockTTL: 30000 });

        await assert.rejects(() => lm.lockKey(ctx, 'k'), /Failed to obtain lock/);
        assert.strictEqual(client.kv.set.mock.callCount(), 1, 'contention must not be retried');
        assert.strictEqual(client.session.destroy.mock.callCount(), 0, 'session must not be rotated on contention');
        await lm.shutdown();
    });

    // L5/L6: a transport error rotates the session once and retries; L-fix: the locker carries the
    // session that actually acquired the lock, not a later value of the mutable field.
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
        assert.strictEqual(client.session.destroy.mock.callCount(), 1, 'old session should be destroyed');
        assert.strictEqual(locker.session, 's2', 'locker must carry the acquiring (rotated) session');
        await lm.shutdown();
    });
});
