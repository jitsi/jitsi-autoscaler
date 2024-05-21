/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import Validator from '../validator';

describe('Validator', () => {
    let context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const instanceTracker = {
        trimCurrent: mock.fn(),
    };

    const instanceGroupManager = {
        getInstanceGroup: mock.fn(),
    };

    const metricsLoop = {
        getCloudInstances: mock.fn(),
    };

    const groupName = 'group';

    const validator = new Validator({ instanceTracker, instanceGroupManager, metricsLoop });

    afterEach(() => {
        context = {
            logger: {
                info: mock.fn(),
                debug: mock.fn(),
                error: mock.fn(),
                warn: mock.fn(),
            },
        };
    });

    // these tests are for the groupHasActiveInstances method
    describe('validator', () => {
        test('should return false for a group with no instances', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => []);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => []);

            const result = await validator.groupHasActiveInstances(context, groupName);
            assert.strictEqual(result, false);
        });

        test('should return true for a group with an instance', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{ instanceId: '1' }]);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => []);

            const result = await validator.groupHasActiveInstances(context, groupName);
            assert.strictEqual(result, true);
        });

        test('should return false for a group with an instance, shutdown completed', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [
                { instanceId: '1', shutdownComplete: true },
            ]);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => []);

            const result = await validator.groupHasActiveInstances(context, groupName);
            assert.strictEqual(result, false);
        });

        test('should return true for a group with one active and one shutdown instance', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [
                { instanceId: '1' },
                { instanceId: '2', shutdownComplete: new Date().toISOString() },
            ]);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => []);

            const result = await validator.groupHasActiveInstances(context, groupName);
            assert.strictEqual(result, true);
        });

        test('should return true for a group with cloud status running', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{ instanceId: '1' }]);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => [
                { instanceId: '1', cloudStatus: 'running' },
            ]);

            const result = await validator.groupHasActiveInstances(context, groupName);
            assert.strictEqual(result, true);
        });

        test('should return false for a group with cloud status shutdown', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{ instanceId: '1' }]);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => [
                { instanceId: '1', cloudStatus: 'shutdown' },
            ]);

            const result = await validator.groupHasActiveInstances(context, groupName);
            assert.strictEqual(result, false);
        });
    });
});
