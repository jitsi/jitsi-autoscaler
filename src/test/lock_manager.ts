/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { describe, mock } from 'node:test';

import { RedLocker, ConsulLocker } from '../lock_manager';

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
