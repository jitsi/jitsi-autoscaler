/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import ShutdownManager from '../shutdown_manager';

describe('ShutdownManager', () => {
    let context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    let _keys = [];

    const mockPipeline = {
        get: mock.fn((key) => _keys.push(key)),
        set: mock.fn(),
        exec: mock.fn(() => Promise.resolve(_keys.map(() => [null, null]))),
    };

    const redisClient = {
        expire: mock.fn(),
        zremrangebyscore: mock.fn(() => 0),
        hgetall: mock.fn(),
        hset: mock.fn(),
        hdel: mock.fn(),
        del: mock.fn(),
        scan: mock.fn(),
        zrange: mock.fn(),
        get: mock.fn(),
        pipeline: mock.fn(() => mockPipeline),
    };

    const audit = {
        log: mock.fn(),
    };

    const shutdownManager = new ShutdownManager({
        redisClient,
        audit,
        shutdownTTL: 86400,
    });

    afterEach(() => {
        _keys = [];
        mockPipeline.exec.mock.resetCalls();
        mockPipeline.get.mock.resetCalls();
        context = {
            logger: {
                info: mock.fn(),
                debug: mock.fn(),
                error: mock.fn(),
                warn: mock.fn(),
            },
        };
        mock.restoreAll();
    });

    // these tests are for the shutdown confirmation statuses
    describe('shutdownConfirmationStatuses', () => {
        test('read non-existent shutdown confirmation status', async () => {
            redisClient.get.mock.mockImplementationOnce(() => null);
            const result = await shutdownManager.getShutdownConfirmation(context, 'instanceId');
            console.log(result);
            assert.equal(result, false, 'expect no shutdown confirmation when no key exists');
        });

        test('read existing shutdown confirmation status', async () => {
            const shutdownConfirmation = new Date().toISOString();
            redisClient.get.mock.mockImplementationOnce(() => shutdownConfirmation);
            const result = await shutdownManager.getShutdownConfirmation(context, 'instanceId');
            console.log(result);
            assert.ok(result, 'expect ok result');
            assert.equal(result, shutdownConfirmation, 'expect shutdown confirmation to match mock date');
        });

        test('read multiple non-existent shutdown confirmation statuses', async () => {
            const instances = ['instanceId', 'instanceId2'];
            const result = await shutdownManager.getShutdownConfirmations(context, instances);
            assert.ok(result, 'expect ok result');
            assert.equal(result.length, instances.length, 'expect confirmation length to match instances length');
            assert.equal(result[0], false, 'expect first confirmation to be false');
            assert.equal(result[1], false, 'expect second confirmation to be false');
        });

        test('read multiple existing shutdown confirmation statuses', async () => {
            const shutdownConfirmation = new Date().toISOString();

            const instances = ['instanceId', 'instanceId2'];
            const result = await shutdownManager.getShutdownConfirmations(context, instances);
            mockPipeline.exec.mock.mockImplementationOnce(() =>
                Promise.resolve(instances.map(() => [null, shutdownConfirmation])),
            );
            assert.ok(result, 'expect ok result');
            assert.equal(mockPipeline.exec.mock.callCount(), 1, 'expect exec to be called once');
            assert.equal(
                mockPipeline.get.mock.callCount(),
                instances.length,
                'expect get to be called once per instance',
            );
            assert.equal(result.length, instances.length, 'expect confirmation length to match instances length');
            assert.equal(result[0], shutdownConfirmation, 'expect first confirmation to match mock date');
            assert.equal(result[1], shutdownConfirmation, 'expect second confirmation to match mock date');
        });
    });
});
