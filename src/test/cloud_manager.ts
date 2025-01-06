/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import CloudManager from '../cloud_manager';

function log(msg, obj) {
    console.log(msg, JSON.stringify(obj));
}

function initContext(): Context {
    return {
        logger: {
            info: mock.fn(log),
            debug: mock.fn(log),
            error: mock.fn(log),
            warn: mock.fn(log),
        },
    };
}

describe('CloudManager', () => {
    let context = initContext();

    const shutdownManager = {
        setScaleDownProtected: mock.fn(() => true),
        areScaleDownProtected: mock.fn((arr) => arr.map(() => false)),
    };

    const instanceTracker = {
        track: mock.fn(),
        trimCurrent: mock.fn(),
    };

    const audit = {
        saveLaunchEvent: mock.fn(),
    };

    const cloudInstanceManager = {
        getInstances: mock.fn(() => []),
        launchInstances: mock.fn((_ctx, _group, _cur, count) => {
            for (let i = 0; i < count; i++) {
                return [`mock-instance-${i}`];
            }
        }),
    };

    const cloudInstanceManagerSelector = {
        selectInstanceManager: mock.fn(() => cloudInstanceManager),
    };

    const cloudManager = new CloudManager({
        shutdownManager,
        instanceTracker,
        audit,
        cloudInstanceManagerSelector,
        cloudProviders: ['mock'],
        isDryRun: false,
    });

    afterEach(() => {
        context = initContext();
        cloudInstanceManager.launchInstances.mock.resetCalls();
        instanceTracker.track.mock.resetCalls();
    });

    describe('cloudManager', () => {
        test('should return empty for a group with no instances', async () => {
            const result = await cloudManager.getInstances(context, 'group');
            assert.deepEqual(result, [], 'no instances');
        });

        test('should return an item for a group with mock instances', async () => {
            const instance = { instanceId: 'mock-instance', cloudStatus: 'running', displayName: 'mockery' };
            cloudInstanceManager.getInstances.mock.mockImplementation(() => [instance]);
            const result = await cloudManager.getInstances(context, 'group');
            assert.deepEqual(result, [instance], 'mock instance');
        });

        test('scaleUp should return success for mock group', async () => {
            const group = { name: 'mock-group', cloud: 'mock', type: 'mock' };
            const currentCount = 0;
            const quantity = 1;
            const isScaleDownProtected = false;
            const result = await cloudManager.scaleUp(context, group, currentCount, quantity, isScaleDownProtected);
            assert.equal(result, 1, 'scale up success');
            assert.equal(cloudInstanceManager.launchInstances.mock.calls.length, 1, 'launch instances called');
            assert.equal(instanceTracker.track.mock.calls.length, 1, 'newly launched instance tracked');
            assert.equal(
                shutdownManager.setScaleDownProtected.mock.calls.length,
                0,
                'launched instance is not scale protected',
            );
        });

        test('scaleUp should return success for mock group, including protected instance call', async () => {
            const group = { name: 'mock-group-protected', cloud: 'mock', type: 'mock' };
            const currentCount = 0;
            const quantity = 1;
            const isScaleDownProtected = true;
            const result = await cloudManager.scaleUp(context, group, currentCount, quantity, isScaleDownProtected);
            assert.equal(result, 1, 'scale up success');
            assert.equal(cloudInstanceManager.launchInstances.mock.calls.length, 1, 'launch instances called');
            assert.equal(instanceTracker.track.mock.calls.length, 1, 'newly launched instance tracked');
            assert.equal(
                shutdownManager.setScaleDownProtected.mock.calls.length,
                1,
                'launched instance is scale protected',
            );
            assert.equal(
                shutdownManager.setScaleDownProtected.mock.calls[0].arguments[2],
                instanceTracker.track.mock.calls[0].arguments[1].instanceId,
                'protected instance id should match tracked instance id',
            );
        });
    });
});
