/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import ScalingManager from '../scaling_options_manager';

describe('ScalingManager', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    function makeGroup(name: string) {
        return {
            name,
            type: 'JVB',
            region: 'r',
            environment: 'e',
            enableScheduler: true,
            scalingOptions: {
                minDesired: 1,
                maxDesired: 5,
                desiredCount: 1,
                scaleUpQuantity: 1,
                scaleDownQuantity: 1,
                scaleUpThreshold: 0.8,
                scaleDownThreshold: 0.3,
                scalePeriod: 60,
                scaleUpPeriodsCount: 2,
                scaleDownPeriodsCount: 2,
            },
        };
    }

    const groups = [makeGroup('g1'), makeGroup('g2'), makeGroup('g3')];
    const lock = { release: mock.fn() };
    const lockManager = { lockGroup: mock.fn(() => lock) };
    const instanceGroupManager = {
        getAllInstanceGroupsByTypeRegionEnvironment: mock.fn(() => groups),
        getInstanceGroup: mock.fn((_ctx, name) => groups.find((g) => g.name === name)),
        upsertInstanceGroup: mock.fn(),
        setAutoScaleGracePeriod: mock.fn(),
    };

    const manager = new ScalingManager({ instanceGroupManager, lockManager });

    const request = {
        instanceType: 'JVB',
        region: 'r',
        environment: 'e',
        direction: 'up',
        options: { desiredCount: 3 },
    };

    afterEach(() => {
        instanceGroupManager.upsertInstanceGroup.mock.resetCalls();
        instanceGroupManager.getInstanceGroup.mock.resetCalls();
        lock.release.mock.resetCalls();
        context.logger.error.mock.resetCalls();
        for (const g of groups) {
            g.scalingOptions.desiredCount = 1;
        }
    });

    test('updates every group when nothing fails', async () => {
        const result = await manager.updateFullScalingOptionsForGroups(request, context);
        assert.strictEqual(result.groupsToBeUpdated, 3);
        assert.strictEqual(result.groupsUpdated, 3);
        assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 3);
        assert.strictEqual(lock.release.mock.calls.length, 3);
    });

    test('a failure for one group does not abort the others and is reported in the counts', async () => {
        instanceGroupManager.upsertInstanceGroup.mock.mockImplementation((_ctx, group) => {
            if (group.name === 'g2') {
                throw new Error('redis down');
            }
        });

        const result = await manager.updateFullScalingOptionsForGroups(request, context);

        assert.strictEqual(result.groupsToBeUpdated, 3);
        assert.strictEqual(result.groupsUpdated, 2);
        // all three were attempted, the lock was released for all three
        assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 3);
        assert.strictEqual(lock.release.mock.calls.length, 3);
        assert.strictEqual(context.logger.error.mock.calls.length, 1);
        instanceGroupManager.upsertInstanceGroup.mock.mockImplementation(() => undefined);
    });

    test('a group that disappeared between listing and locking counts as not updated', async () => {
        instanceGroupManager.getInstanceGroup.mock.mockImplementation((_ctx, name) =>
            name === 'g3' ? undefined : groups.find((g) => g.name === name),
        );

        const result = await manager.updateFullScalingOptionsForGroups(request, context);

        assert.strictEqual(result.groupsUpdated, 2);
        assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 2);
        instanceGroupManager.getInstanceGroup.mock.mockImplementation((_ctx, name) =>
            groups.find((g) => g.name === name),
        );
    });
});
