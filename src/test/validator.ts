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

    const shutdownManager = {
        getShutdownConfirmations: mock.fn((_ctx, _group, instanceIds) => instanceIds.map(() => false)),
    };

    const groupName = 'group';

    const validator = new Validator({ instanceTracker, instanceGroupManager, metricsLoop, shutdownManager });

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

        test('should return false for a group with an instance that has sent back completed webhook', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [
                { instanceId: '1', shutdownComplete: true },
            ]);
            metricsLoop.getCloudInstances.mock.mockImplementationOnce(() => []);
            shutdownManager.getShutdownConfirmations.mock.mockImplementationOnce(() => ['completed']);

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

        test('supportedInstanceType accepts the exact supported type strings', async () => {
            assert.strictEqual(await validator.supportedInstanceType('availability'), true);
            assert.strictEqual(await validator.supportedInstanceType('stress'), true);
            assert.strictEqual(await validator.supportedInstanceType('JVB'), true);
            assert.strictEqual(await validator.supportedInstanceType('selenium-grid'), true);
        });

        test('supportedInstanceType is case-sensitive and rejects unknown types', async () => {
            assert.strictEqual(await validator.supportedInstanceType('jvb'), false);
            assert.strictEqual(await validator.supportedInstanceType('foo'), false);
            assert.strictEqual(await validator.supportedInstanceType(''), false);
            assert.strictEqual(await validator.supportedInstanceType(null), false);
            assert.strictEqual(await validator.supportedInstanceType(undefined), false);
        });

        test('groupHasValidDesiredInput returns false for a nonexistent group', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => null);
            const result = await validator.groupHasValidDesiredInput(context, 'missing', { desiredCount: 1 });
            assert.strictEqual(result, false);
        });

        test('canLaunchInstances returns false for a nonexistent group', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => null);
            const req = { context, params: { name: 'missing' }, body: {} };
            const result = await validator.canLaunchInstances(req, 1);
            assert.strictEqual(result, false);
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
