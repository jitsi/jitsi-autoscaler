/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import AutoscaleProcessor from '../autoscaler';
import { InstanceTracker } from '../instance_tracker';

describe('AutoscaleProcessor', () => {
    let context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const groupName = 'group';
    const groupDetails = {
        name: groupName,
        type: 'test',
        region: 'default',
        environment: 'test',
        compartmentId: 'test',
        instanceConfigurationId: 'test',
        enableAutoScale: true,
        enableLaunch: false,
        gracePeriodTTLSec: 480,
        protectedTTLSec: 600,
        scalingOptions: {
            minDesired: 1,
            maxDesired: 1,
            desiredCount: 1,
            scaleUpQuantity: 1,
            scaleDownQuantity: 1,
            scaleUpThreshold: 5,
            scaleDownThreshold: 2,
            scalePeriod: 60,
            scaleUpPeriodsCount: 2,
            scaleDownPeriodsCount: 2,
        },
    };
    const lock = { unlock: mock.fn() };

    const lockManager = {
        lockGroup: mock.fn(() => lock),
    };

    const instanceGroupManager = {
        getInstanceGroup: mock.fn(() => {
            return groupDetails;
        }),
        allowAutoscaling: mock.fn(),
        upsertInstanceGroup: mock.fn(),
    };

    const instanceTracker = {
        trimCurrent: mock.fn(),
        getMetricInventoryPerPeriod: mock.fn(),
        getSummaryMetricPerPeriod: InstanceTracker.prototype.getSummaryMetricPerPeriod,
    };

    const audit = {
        saveAutoScalerActionItem: mock.fn(),
        updateLastAutoScalerRun: mock.fn(),
    };

    const autoscaleProcessor = new AutoscaleProcessor({
        instanceGroupManager,
        lockManager,
        instanceTracker,
        audit,
    });

    afterEach(() => {
        context = {
            logger: {
                info: mock.fn(),
                debug: mock.fn(),
                error: mock.fn(),
                warn: mock.fn(),
            },
        };
        instanceTracker.trimCurrent.mock.resetCalls();
        instanceTracker.getMetricInventoryPerPeriod.mock.resetCalls();
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
            // instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetails);
            const disabledGroup = { ...groupDetails, enableAutoScale: false };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return disabledGroup;
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Autoscaling not enabled for group ${groupDetails.name}`,
            );

            assert.strictEqual(result, false);
        });

        test('will exit if autoscaling activity has occurred recently', async () => {
            autoscaleProcessor.instanceGroupManager.allowAutoscaling.mock.mockImplementationOnce(() => false);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Wait before allowing desired count adjustments for group ${groupDetails.name}`,
            );

            assert.strictEqual(result, false);
        });

        test('will not perform metrics calculations if no instances are found in the group', async () => {
            instanceGroupManager.allowAutoscaling.mock.mockImplementationOnce(() => true);
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => []);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            assert.strictEqual(result, false);
        });

        test('will not updated desired count if current count does not match group desired', async () => {
            instanceGroupManager.allowAutoscaling.mock.mockImplementationOnce(() => true);
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{}, {}]);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Wait for the launcher to finish scaling up/down instances for group ${groupDetails.name}`,
            );
            assert.strictEqual(result, true);
        });

        test('will not updated desired count if no metrics are available', async () => {
            instanceGroupManager.allowAutoscaling.mock.mockImplementationOnce(() => true);
            instanceTracker.trimCurrent.mock.resetCalls();
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{}]);
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
            assert.deepEqual(
                context.logger.warn.mock.calls[0].arguments[0],
                `[AutoScaler] No metrics available, no desired count adjustments possible for group ${groupDetails.name} with 1 instances`,
            );
            assert.strictEqual(result, true);
        });
    });
});
