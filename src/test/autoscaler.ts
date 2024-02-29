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
        type: 'JVB',
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
        allowAutoscaling: mock.fn(() => true),
        upsertInstanceGroup: mock.fn(),
    };

    const instanceTracker = {
        trimCurrent: mock.fn(),
        getMetricInventoryPerPeriod: mock.fn(() => {
            return [
                [{ value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                [{ value: 0.4, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                [{ value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
            ];
        }),
        getSummaryMetricPerPeriod: InstanceTracker.prototype.getSummaryMetricPerPeriod,
        getAverageMetricPerPeriod: InstanceTracker.prototype.getAverageMetricPerPeriod,
        computeSummaryMetric: InstanceTracker.prototype.computeSummaryMetric,
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
        audit.updateLastAutoScalerRun.mock.resetCalls();
        mock.reset();
    });

    describe('processAutoscalingByGroup utilityTests', () => {
        test('will choose to scale up when threshold is exceeded', async () => {
            const scaleMetrics = [1, 1];
            const count = 1;
            const direction = 'up';
            const group = {
                ...groupDetails,
                // scale up at 0.8, and bump maxDesired to allow for scaling up choice
                scalingOptions: { ...groupDetails.scalingOptions, scaleUpThreshold: 0.8, maxDesired: 2 },
            };
            const scaleDecision = autoscaleProcessor.evalScaleConditionForAllPeriods(
                context,
                scaleMetrics,
                count,
                group,
                direction,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Evaluating scale ${direction} choice for group ${groupName} with ${count} instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
            );

            assert.strictEqual(scaleDecision, true);
        });
        test('will skip scaling up when threshold is not exceeded', async () => {
            const scaleMetrics = [0.5, 0.5];
            const count = 1;
            const direction = 'up';
            const group = {
                ...groupDetails,
                // scale up at 0.8, and bump maxDesired to allow for scaling up choice
                scalingOptions: { ...groupDetails.scalingOptions, scaleUpThreshold: 0.8, maxDesired: 2 },
            };
            const scaleDecision = autoscaleProcessor.evalScaleConditionForAllPeriods(
                context,
                scaleMetrics,
                count,
                group,
                direction,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Evaluating scale ${direction} choice for group ${groupName} with ${count} instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
            );

            assert.strictEqual(scaleDecision, false);
        });
        test('will choose to scale down when threshold is not met', async () => {
            const scaleMetrics = [0.1, 0.1];
            const count = 1;
            const direction = 'down';
            const group = {
                ...groupDetails,
                // scale down at 0.3, and reduce minDesired to allow for scaling down choice
                scalingOptions: { ...groupDetails.scalingOptions, scaleDownThreshold: 0.3, minDesired: 0 },
            };
            const scaleDecision = autoscaleProcessor.evalScaleConditionForAllPeriods(
                context,
                scaleMetrics,
                count,
                group,
                direction,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Evaluating scale ${direction} choice for group ${groupName} with ${count} instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
            );

            assert.strictEqual(scaleDecision, true);
        });
        test('will skip scaling down when threshold is met', async () => {
            const scaleMetrics = [0.5, 0.5];
            const count = 1;
            const direction = 'down';
            const group = {
                ...groupDetails,
                // scale up at 0.8, and bump maxDesired to allow for scaling up choice
                scalingOptions: { ...groupDetails.scalingOptions, scaleUpThreshold: 0.8, maxDesired: 2 },
            };
            const scaleDecision = autoscaleProcessor.evalScaleConditionForAllPeriods(
                context,
                scaleMetrics,
                count,
                group,
                direction,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Evaluating scale ${direction} choice for group ${groupName} with ${count} instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
            );

            assert.strictEqual(scaleDecision, false);
        });
    });

    describe('processAutoscalingByGroup scalingTests', () => {
        test('will choose to increase desired count', async () => {
            // do something
        });
        test('will choose to increase desired count to maximum and not higher', async () => {
            // do something
        });
        test('would choose to increase desired count but maximum was reached', async () => {
            // do something
        });
        test('will choose to decrease desired count', async () => {
            // do something
        });
        test('will choose to increase desired count to minimum and not lower', async () => {
            // do something
        });
        test('would choose to decrease desired count but minimum was reached', async () => {
            // do something
        });
    });

    describe('processAutoscalingByGroup noopTests', () => {
        test('will try to set a redis lock and exit if it fails', async () => {
            const error = new Error('lock error');
            lockManager.lockGroup.mock.mockImplementationOnce(() => {
                throw error;
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(context.logger.warn.mock.calls[0].arguments[1], { err: error });
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 0);
            assert.strictEqual(result, false);
        });

        test('will throw an error if the group is not found', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => false);

            await assert.rejects(() => autoscaleProcessor.processAutoscalingByGroup(context, groupName), {
                message: `Group ${groupName} not found, failed to process autoscaling`,
            });
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 0);
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

            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 0);
            assert.strictEqual(result, false);
        });

        test('will exit if autoscaling activity has occurred recently', async () => {
            autoscaleProcessor.instanceGroupManager.allowAutoscaling.mock.mockImplementationOnce(() => false);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `[AutoScaler] Wait before allowing desired count adjustments for group ${groupDetails.name}`,
            );

            // assert no inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 0);
            // no updates to the instance group are expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            // assert process ended with failure
            assert.strictEqual(result, false);
        });

        test('will not perform metrics calculations if no instances are found in the group', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => []);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert no updates to the instance group are expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            // assert process ended with failure
            assert.strictEqual(result, false);
        });

        test('will not updated desired count if current count does not match group desired', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{}, {}]);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Wait for the launcher to finish scaling up/down instances for group ${groupDetails.name}`,
            );
            // assert no updates to the instance group are expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            // assert process ended with success
            assert.strictEqual(result, true);
        });

        test('will not updated desired count if no metrics are available', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{}]);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => []);
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
            assert.deepEqual(
                context.logger.warn.mock.calls[0].arguments[0],
                `[AutoScaler] No metrics available, no desired count adjustments possible for group ${groupDetails.name} with 1 instances`,
            );
            // assert no updates to the instance group are expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            // assert process ended with success
            assert.strictEqual(result, true);
        });

        test('will not updated desired count if no changes are indicated based on metrics', async () => {
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }]);
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Evaluating scale down choice for group ${groupName} with 1 instances and current desired count ${groupDetails.scalingOptions.desiredCount}`,
                `[AutoScaler] No desired count adjustments needed for group ${groupName} with 1 instances`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[3].arguments[0],
                `[AutoScaler] No desired count adjustments needed for group ${groupName} with 1 instances`,
            );
            // no updates to the instance group are expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[2], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
    });
});
