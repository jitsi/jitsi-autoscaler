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
    const lock = { release: mock.fn() };

    const lockManager = {
        lockGroup: mock.fn(() => lock),
    };

    const instanceGroupManager = {
        getInstanceGroup: mock.fn(() => {
            return groupDetails;
        }),
        allowAutoscaling: mock.fn(() => true),
        upsertInstanceGroup: mock.fn(),
        setAutoScaleGracePeriod: mock.fn(),
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

    const cloudManager = {
        getInstances: mock.fn(() => []),
    };

    const cloudRetryStrategy = {
        maxTimeInSeconds: 30,
        maxDelayInSeconds: 10,
        retryableStatusCodes: [429, 500, 503],
    };

    const autoscaleProcessor = new AutoscaleProcessor({
        instanceGroupManager,
        lockManager,
        instanceTracker,
        audit,
        cloudManager,
        cloudRetryStrategy,
        cloudGuardEnabled: true,
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
        instanceGroupManager.upsertInstanceGroup.mock.resetCalls();
        audit.updateLastAutoScalerRun.mock.resetCalls();
        audit.saveAutoScalerActionItem.mock.resetCalls();
        cloudManager.getInstances.mock.resetCalls();
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
            const scalableGroup = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, maxDesired: 2, scaleUpThreshold: 0.8 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return scalableGroup;
            });
            const inventory = [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }];

            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return [
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                ];
            });

            const currentDesired = scalableGroup.scalingOptions.desiredCount;
            const expectedDesired = 2;
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 1);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Increasing desired count to ${expectedDesired} for group ${groupName} with ${inventory.length} instances`,
            );

            assert.deepEqual(context.logger.info.mock.calls[2].arguments[1], { desiredCount: expectedDesired });
            // one update to the instance group is expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
        test('will choose to increase desired count to maximum and not higher', async () => {
            const scalableGroup = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    maxDesired: 2,
                    scaleUpThreshold: 0.8,
                    scaleUpQuantity: 5,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return scalableGroup;
            });
            const inventory = [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }];

            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return [
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                ];
            });

            const currentDesired = scalableGroup.scalingOptions.desiredCount;
            const expectedDesired = 2;
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert one action items was saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 1);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Increasing desired count to ${expectedDesired} for group ${groupName} with ${inventory.length} instances`,
            );

            assert.deepEqual(context.logger.info.mock.calls[2].arguments[1], { desiredCount: expectedDesired });
            // one update to the instance group is expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
        test('would choose to increase desired count but maximum was reached', async () => {
            const scalableGroup = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, scaleUpThreshold: 0.8 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return scalableGroup;
            });
            const inventory = [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }];

            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return [
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                ];
            });

            const currentDesired = scalableGroup.scalingOptions.desiredCount;
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Evaluating scale down choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[3].arguments[0],
                `[AutoScaler] No desired count adjustments needed for group ${groupName} with 1 instances`,
            );

            // no updates to the instance group is expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
        test('will choose to decrease desired count', async () => {
            const scalableGroup = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, minDesired: 0, scaleDownThreshold: 0.3 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return scalableGroup;
            });
            const inventory = [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }];

            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return [
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                ];
            });

            const currentDesired = scalableGroup.scalingOptions.desiredCount;
            const expectedDesired = 0;
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 1);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Evaluating scale down choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[3].arguments[0],
                `[AutoScaler] Reducing desired count to ${expectedDesired} for group ${groupName} with ${inventory.length} instances`,
            );

            assert.deepEqual(context.logger.info.mock.calls[3].arguments[1], { desiredCount: expectedDesired });
            // one update to the instance group is expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
        test('will choose to increase desired count to minimum and not lower', async () => {
            const scalableGroup = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    minDesired: 0,
                    scaleDownThreshold: 0.3,
                    scaleDownQuantity: 5,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return scalableGroup;
            });
            const inventory = [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }];

            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return [
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                ];
            });

            const currentDesired = scalableGroup.scalingOptions.desiredCount;
            const expectedDesired = 0;
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 1);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Evaluating scale down choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[3].arguments[0],
                `[AutoScaler] Reducing desired count to ${expectedDesired} for group ${groupName} with ${inventory.length} instances`,
            );

            assert.deepEqual(context.logger.info.mock.calls[3].arguments[1], { desiredCount: expectedDesired });
            // one update to the instance group is expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
        test('would choose to decrease desired count but minimum was reached', async () => {
            const scalableGroup = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, scaleDownThreshold: 0.3 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => {
                return scalableGroup;
            });
            const inventory = [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }];

            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);
            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return [
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                    [{ value: 0.1, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                ];
            });

            const currentDesired = scalableGroup.scalingOptions.desiredCount;
            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // assert inventory was read
            assert.deepEqual(instanceTracker.trimCurrent.mock.calls.length, 1);
            // assert metric inventory was read
            assert.deepEqual(instanceTracker.getMetricInventoryPerPeriod.mock.calls.length, 1);
            // assert no action items were saved
            assert.deepEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);

            assert.deepEqual(
                context.logger.debug.mock.calls[0].arguments[0],
                `[AutoScaler] Begin desired count adjustments for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[1].arguments[0],
                `[AutoScaler] Evaluating scale up choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[2].arguments[0],
                `[AutoScaler] Evaluating scale down choice for group ${groupName} with 1 instances and current desired count ${currentDesired}`,
            );

            assert.deepEqual(
                context.logger.info.mock.calls[3].arguments[0],
                `[AutoScaler] No desired count adjustments needed for group ${groupName} with 1 instances`,
            );

            // no updates to the instance group is expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
    });

    describe('processAutoscalingByGroup cloudGuardTests', () => {
        test('will suppress scale-up when cloud shows enough running instances but sidecar count is low', async () => {
            // Scenario: desired=10, sidecar reports 5, cloud shows 10 running
            // → cloud guard should suppress autoscaling
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 10,
                    maxDesired: 15,
                    minDesired: 1,
                    scaleUpThreshold: 0.8,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            // Sidecar reports 5 instances
            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            // Cloud shows 10 running instances
            const cloudInstances = Array.from({ length: 10 }, (_, i) => ({
                instanceId: `i-${i}`,
                displayName: `instance-${i}`,
                cloudStatus: 'RUNNING',
            }));
            cloudManager.getInstances.mock.mockImplementationOnce(() => cloudInstances);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // Cloud guard should have fired
            assert.strictEqual(cloudManager.getInstances.mock.calls.length, 1, 'cloud API was called');
            assert.strictEqual(result, false, 'autoscaling was suppressed');
            // No desired count update should have occurred
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
        });

        test('will allow scale-up when cloud count also shows real instance loss', async () => {
            // Scenario: desired=10, sidecar reports 5, cloud also shows only 5
            // → real instance loss, allow autoscaling to proceed
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 5,
                    maxDesired: 15,
                    minDesired: 1,
                    scaleUpThreshold: 0.8,
                    scaleUpPeriodsCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            // Sidecar reports 5 instances (matches desired, so cloud guard won't fire)
            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return inventory.map(() => [{ value: 1, instanceId: 'i-0' }]);
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // Cloud guard should NOT have been called (count == desiredCount)
            assert.strictEqual(cloudManager.getInstances.mock.calls.length, 0, 'cloud API was not called');
            assert.strictEqual(result, true, 'autoscaling proceeded normally');
        });

        test('will not call cloud API when sidecar count equals desired count', async () => {
            // Normal operation: count == desiredCount → no cloud check needed
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => [{ instance_id: 'i-0a1b2c3d4e5f6g7h8' }]);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            assert.strictEqual(cloudManager.getInstances.mock.calls.length, 0, 'cloud API was not called');
            assert.strictEqual(result, true);
        });

        test('will allow autoscaling when cloud count is also below desired', async () => {
            // Scenario: desired=10, sidecar reports 5, cloud shows 5
            // → genuine loss, allow autoscaling
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 10,
                    maxDesired: 15,
                    minDesired: 1,
                    scaleUpThreshold: 0.8,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            // Cloud also shows only 5 instances
            const cloudInstances = Array.from({ length: 5 }, (_, i) => ({
                instanceId: `i-${i}`,
                displayName: `instance-${i}`,
                cloudStatus: 'RUNNING',
            }));
            cloudManager.getInstances.mock.mockImplementationOnce(() => cloudInstances);

            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return inventory.map(() => [{ value: 1, instanceId: 'i-0' }]);
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // Cloud guard was called but didn't suppress
            assert.strictEqual(cloudManager.getInstances.mock.calls.length, 1, 'cloud API was called');
            assert.strictEqual(result, true, 'autoscaling proceeded');
        });
        test('grace=0 still suppresses (backward compat)', async () => {
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 10,
                    maxDesired: 15,
                    minDesired: 1,
                    cloudGuardGraceCount: 0,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            const cloudInstances = Array.from({ length: 10 }, (_, i) => ({
                instanceId: `i-${i}`,
                displayName: `instance-${i}`,
                cloudStatus: 'RUNNING',
            }));
            cloudManager.getInstances.mock.mockImplementationOnce(() => cloudInstances);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);
            assert.strictEqual(result, false, 'autoscaling was suppressed');
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
        });

        test('grace allows processing when cloud < desired', async () => {
            // desired=14, cloud=10, grace=2 → cloudRunning(10) < desired(14) → guard doesn't fire
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 14,
                    maxDesired: 20,
                    minDesired: 1,
                    scaleUpThreshold: 0.8,
                    cloudGuardGraceCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            const cloudInstances = Array.from({ length: 10 }, (_, i) => ({
                instanceId: `i-${i}`,
                displayName: `instance-${i}`,
                cloudStatus: 'RUNNING',
            }));
            cloudManager.getInstances.mock.mockImplementationOnce(() => cloudInstances);

            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return inventory.map(() => [{ value: 1, instanceId: 'i-0' }]);
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);
            assert.strictEqual(cloudManager.getInstances.mock.calls.length, 1, 'cloud API was called');
            assert.strictEqual(result, true, 'autoscaling proceeded');
        });

        test('grace allows autoscaling when cloud is at desired but within grace window', async () => {
            // desired=10, cloud=10, grace=2 → graceLimit=12, cloudRunning(10) < 12 → allow
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 10,
                    maxDesired: 15,
                    minDesired: 1,
                    scaleUpThreshold: 0.8,
                    cloudGuardGraceCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            const cloudInstances = Array.from({ length: 10 }, (_, i) => ({
                instanceId: `i-${i}`,
                displayName: `instance-${i}`,
                cloudStatus: 'RUNNING',
            }));
            cloudManager.getInstances.mock.mockImplementationOnce(() => cloudInstances);

            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return inventory.map(() => [{ value: 1, instanceId: 'i-0' }]);
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);
            assert.strictEqual(result, true, 'autoscaling proceeded (within grace window)');
        });

        test('grace suppresses when cloud exceeds grace limit', async () => {
            // desired=10, cloud=12, grace=2 → graceLimit=12, cloudRunning(12) >= 12 → suppress
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 10,
                    maxDesired: 15,
                    minDesired: 1,
                    cloudGuardGraceCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            const cloudInstances = Array.from({ length: 12 }, (_, i) => ({
                instanceId: `i-${i}`,
                displayName: `instance-${i}`,
                cloudStatus: 'RUNNING',
            }));
            cloudManager.getInstances.mock.mockImplementationOnce(() => cloudInstances);

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);
            assert.strictEqual(result, false, 'autoscaling was suppressed');
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
        });
        test('cloud guard proceeds without guard when cloud API fails', async () => {
            // Scenario: desired=10, sidecar reports 5, cloud API throws
            // → circuit breaker should allow autoscaling to proceed
            const scalableGroup = {
                ...groupDetails,
                enableCloudGuard: true,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 10,
                    maxDesired: 15,
                    minDesired: 1,
                    scaleUpThreshold: 0.8,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => scalableGroup);

            const inventory = Array.from({ length: 5 }, (_, i) => ({ instance_id: `i-${i}` }));
            instanceTracker.trimCurrent.mock.mockImplementationOnce(() => inventory);

            // Cloud API fails
            cloudManager.getInstances.mock.mockImplementationOnce(() => {
                throw new Error('cloud API unavailable');
            });

            instanceTracker.getMetricInventoryPerPeriod.mock.mockImplementationOnce(() => {
                return inventory.map(() => [{ value: 1, instanceId: 'i-0' }]);
            });

            const result = await autoscaleProcessor.processAutoscalingByGroup(context, groupName);

            // Should have proceeded despite cloud API failure
            assert.strictEqual(cloudManager.getInstances.mock.calls.length, 1, 'cloud API was attempted');
            assert.strictEqual(result, true, 'autoscaling proceeded (circuit breaker)');
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
            );

            assert.deepEqual(
                context.logger.info.mock.calls[3].arguments[0],
                `[AutoScaler] No desired count adjustments needed for group ${groupName} with 1 instances`,
            );
            // no updates to the instance group are expected
            assert.deepEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);

            assert.deepEqual(audit.updateLastAutoScalerRun.mock.callCount(), 1);
            assert.deepEqual(audit.updateLastAutoScalerRun.mock.calls[0].arguments[1], groupName);
            // assert process ended with success
            assert.strictEqual(result, true);
        });
    });
});
