/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import { mockStore } from './mock_store';

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

    const audit = {
        log: mock.fn(),
    };

    const shutdownManager = new ShutdownManager({
        instanceStore: mockStore,
        audit,
        shutdownTTL: 86400,
    });

    afterEach(() => {
        mockStore.getShutdownConfirmations.mock.resetCalls();
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
            const result = await shutdownManager.getShutdownConfirmation(context, 'instanceId');
            assert.equal(result, false, 'expect no shutdown confirmation when no key exists');
        });

        test('read existing shutdown confirmation status', async () => {
            const shutdownConfirmation = new Date().toISOString();
            mockStore.getShutdownConfirmation.mock.mockImplementationOnce(() => shutdownConfirmation);
            const result = await shutdownManager.getShutdownConfirmation(context, 'instanceId');
            assert.ok(result, 'expect ok result');
            assert.equal(result, shutdownConfirmation, 'expect shutdown confirmation to match mock date');
        });

        test('read multiple non-existent shutdown confirmation statuses', async () => {
            const instances = ['instanceId', 'instanceId2'];
            mockStore.getShutdownConfirmations.mock.mockImplementationOnce(() => [false, false]);
            const result = await shutdownManager.getShutdownConfirmations(context, instances);
            assert.ok(result, 'expect ok result');
            assert.equal(result.length, instances.length, 'expect confirmation length to match instances length');
            assert.equal(result[0], false, 'expect first confirmation to be false');
            assert.equal(result[1], false, 'expect second confirmation to be false');
        });

        test('read multiple existing shutdown confirmation statuses', async () => {
            const shutdownConfirmation = new Date().toISOString();

            const instances = ['instanceId', 'instanceId2'];
            mockStore.getShutdownConfirmations.mock.mockImplementationOnce(() => [
                shutdownConfirmation,
                shutdownConfirmation,
            ]);

            const result = await shutdownManager.getShutdownConfirmations(context, instances);
            assert.ok(result, 'expect ok result');
            assert.equal(
                mockStore.getShutdownConfirmations.mock.callCount(),
                1,
                'expect getShutdownConfirmations to be called once',
            );
            assert.equal(result.length, instances.length, 'expect confirmation length to match instances length');
            assert.equal(result[0], shutdownConfirmation, 'expect first confirmation to match mock date');
            assert.equal(result[1], shutdownConfirmation, 'expect second confirmation to match mock date');
        });

        test('read multiple mixed shutdown confirmation statuses', async () => {
            const shutdownConfirmation = new Date().toISOString();

            const instances = ['instanceId', 'instanceId2'];
            mockStore.getShutdownConfirmations.mock.mockImplementationOnce(() => [false, shutdownConfirmation]);

            const result = await shutdownManager.getShutdownConfirmations(context, instances);
            assert.ok(result, 'expect ok result');
            assert.equal(
                mockStore.getShutdownConfirmations.mock.callCount(),
                1,
                'expect getShutdownConfirmations to be called once',
            );
            assert.equal(result.length, instances.length, 'expect confirmation length to match instances length');
            assert.equal(result[0], false, 'expect first confirmation to be false');
            assert.equal(result[1], shutdownConfirmation, 'expect second confirmation to match mock date');
        });
    });
});
