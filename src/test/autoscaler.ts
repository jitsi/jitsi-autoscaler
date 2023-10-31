/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import AutoscaleProcessor from '../autoscaler';

describe('AutoscaleProcessor', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const groupName = 'group';
    const lock = { unlock: mock.fn() };

    const lockManager = {
        lockGroup: mock.fn(() => lock),
    };

    const instanceGroupManager = {
        getInstanceGroup: mock.fn(),
    };

    const autoscaleProcessor = new AutoscaleProcessor({
        instanceGroupManager,
        lockManager,
    });

    afterEach(() => {
        mock.restoreAll();
    });

    describe('processAutoscalingByGroup', () => {
        test('will try to set a redis lock and exit if it fails', async () => {
            const error = new Error('lock error');
            lockManager.lockGroup.mock.mockImplementationOnce(() => {
                throw error;
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(context.logger.warn.mock.calls[0].arguments[1], { err: error });
            assert.strictEqual(result, false);
        });

        test('will throw an error if the group is not found', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => false);

            await assert.rejects(() => autoscaleProcessor.processAutoscalingByGroup(context, groupName), {
                message: `Group ${groupName} not found, failed to process autoscaling`,
            });
        });

        test('will exit if group autoscaling is disabled', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                autoscaling: false,
            }));

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.strictEqual(result, false);
        });
    });
});
