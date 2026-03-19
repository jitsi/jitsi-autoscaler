/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import InstanceTracker from '../instance_tracker';
import InstanceLauncher from '../instance_launcher';

function log(msg, obj) {
    console.log(msg, JSON.stringify(obj));
}

function initContext() {
    return {
        logger: {
            info: mock.fn(log),
            debug: mock.fn(log),
            error: mock.fn(log),
            warn: mock.fn(log),
        },
    };
}

describe('InstanceLauncher', () => {
    let context = initContext();

    const shutdownManager = {
        shutdown: mock.fn(),
        areScaleDownProtected: mock.fn(() => []),
    };

    const audit = {
        updateLastLauncherRun: mock.fn(),
        saveLauncherActionItem: mock.fn(),
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
        enableLaunch: true,
        gracePeriodTTLSec: 480,
        protectedTTLSec: 600,
        scalingOptions: {
            minDesired: 1,
            maxDesired: 1,
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

    const inventory = [
        {
            instanceId: 'i-deadbeef007',
            metadata: { group: groupName },
            status: { provisioning: false, stats: { stress_level: 0.5, participants: 1 } },
        },
    ];

    const instanceGroupManager = {
        getInstanceGroup: mock.fn(() => groupDetails),
        isScaleDownProtected: mock.fn(() => false),
    };

    const cloudManager = {
        scaleUp: mock.fn(() => groupDetails.scalingOptions.scaleUpQuantity),
        scaleDown: mock.fn(),
        getInstances: mock.fn(() => []),
    };

    const instanceTracker = {
        trimCurrent: mock.fn(() => inventory),
        mapToInstanceDetails: mock.fn((i) => InstanceTracker.mapToInstanceDetails(i)),
    };

    const metricsLoop = {
        updateMetrics: mock.fn(),
        getUnTrackedCount: mock.fn(() => 0),
    };

    // now we can create an instance of the class
    const instanceLauncher = new InstanceLauncher({
        instanceTracker,
        instanceGroupManager,
        cloudManager,
        shutdownManager,
        audit,
        metricsLoop,
    });

    const groupDetailsDesired0 = {
        ...groupDetails,
        scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 0, minDesired: 0 },
    };

    afterEach(() => {
        audit.updateLastLauncherRun.mock.resetCalls();
        instanceTracker.trimCurrent.mock.resetCalls();
        shutdownManager.areScaleDownProtected.mock.resetCalls();
        cloudManager.scaleDown.mock.resetCalls();
        cloudManager.scaleUp.mock.resetCalls();
        cloudManager.getInstances.mock.resetCalls();
        metricsLoop.getUnTrackedCount.mock.resetCalls();
        context = initContext();
    });

    describe('instanceLauncher basic tests', () => {
        // first test if disabled group exits correctly
        test('launchOrShutdownInstancesByGroup should return false if group is disabled', async () => {
            const groupDetailsDisabled = { ...groupDetails, enableLaunch: false };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDisabled);
            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, false, 'skip disabled group');
        });

        // now test if enable group does nothing with desired of 1 and inventory of 1
        test('launchOrShutdownInstancesByGroup should return true if desired is 1 and inventory is 1', async () => {
            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'skip desired=1 and inventory=1');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'no scaleUp');
            assert.equal(cloudManager.scaleDown.mock.calls.length, 0, 'no scaleDown');
            assert.equal(instanceTracker.trimCurrent.mock.calls.length, 1, 'trimCurrent called');
            assert.equal(audit.updateLastLauncherRun.mock.calls.length, 1, 'audit.updateLastLauncherRun called');
            assert.equal(context.logger.info.mock.calls.length, 2, 'logger.info called');
            assert.equal(
                context.logger.info.mock.calls[0].arguments[0],
                '[Launcher] Instance counts for scaling decision',
            );
            assert.equal(
                context.logger.info.mock.calls[1].arguments[0],
                '[Launcher] No scaling activity needed for group group with 1 instances.',
            );
        });

        // now test if scaleDown occurs with desired of 0 and inventory of 1
        test('launchOrShutdownInstancesByGroup should return true if desired is 0 and inventory is 1', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired0);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'scaleDown desired=0 and inventory=1');
            assert.equal(audit.updateLastLauncherRun.mock.calls.length, 1, 'audit.updateLastLauncherRun called');
            assert.equal(instanceTracker.trimCurrent.mock.calls.length, 1, 'trimCurrent called');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'no scaleUp');
            assert.equal(cloudManager.scaleDown.mock.calls.length, 1, 'scaleDown called');
            assert.equal(shutdownManager.areScaleDownProtected.mock.calls.length, 1, 'areScaleDownProtected called');
            assert.equal(context.logger.info.mock.calls.length, 2, 'logger.info called');
            assert.equal(
                context.logger.info.mock.calls[1].arguments[0],
                '[Launcher] Will scale down to the desired count',
            );
        });

        // now test if scaleUp occurs with desired of 2 and inventory of 1
        test('launchOrShutdownInstancesByGroup should return true if desired is 2 and inventory is 1', async () => {
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'scaleDown desired=0 and inventory=1');
            assert.equal(audit.updateLastLauncherRun.mock.calls.length, 1, 'audit.updateLastLauncherRun called');
            assert.equal(instanceTracker.trimCurrent.mock.calls.length, 1, 'trimCurrent called');
            assert.equal(cloudManager.scaleDown.mock.calls.length, 0, 'no scaleDown');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            assert.equal(
                shutdownManager.areScaleDownProtected.mock.calls.length,
                0,
                'areScaleDownProtected not called',
            );
            assert.equal(context.logger.info.mock.calls.length, 2, 'logger.info called');
            assert.equal(
                context.logger.info.mock.calls[1].arguments[0],
                '[Launcher] Will scale up to the desired count',
            );
        });
    });

    describe('instanceLauncher scaleUp protection tests', () => {
        test('launchOrShutdownInstancesByGroup should launch an instance without protected mode if group is not protected', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch unprotected instance');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            assert.equal(cloudManager.scaleUp.mock.calls[0].arguments[4], false, 'unprotected instance');
        });

        test('launchOrShutdownInstancesByGroup should launch an instance in protected mode if group is protected', async () => {
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            instanceGroupManager.isScaleDownProtected.mock.mockImplementationOnce(() => true);
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch protected instance');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            assert.equal(cloudManager.scaleUp.mock.calls[0].arguments[4], true, 'protected instance');
        });
    });

    describe('instanceLauncher effectiveCount and cloud guard tests', () => {
        test('effectiveCount prevents launching when untracked instances fill the gap', async () => {
            // tracked=1, untracked=1, desired=2, maxDesired=2
            // effectiveCount = 2 == desired → no launch
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 1);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'succeeded without launching');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'no scaleUp');
            assert.equal(cloudManager.getInstances.mock.calls.length, 0, 'no cloud check needed');
        });

        test('effectiveCount allows launching when untracked count is zero', async () => {
            // tracked=1, untracked=0, desired=2, maxDesired=2
            // effectiveCount = 1 < desired → should launch
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            // Cloud check returns fewer than desired → allow launch
            cloudManager.getInstances.mock.mockImplementationOnce(() => [
                { instanceId: 'i-1', displayName: 'inst-1', cloudStatus: 'RUNNING' },
            ]);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch succeeded');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
        });

        test('cloud guard prevents launching when cloud shows enough running instances', async () => {
            // tracked=1, untracked=0, desired=2, maxDesired=2
            // effectiveCount = 1 < desired → wants to launch
            // But cloud shows 2 running → skip launch
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            // Cloud check returns enough instances
            cloudManager.getInstances.mock.mockImplementationOnce(() => [
                { instanceId: 'i-1', displayName: 'inst-1', cloudStatus: 'RUNNING' },
                { instanceId: 'i-2', displayName: 'inst-2', cloudStatus: 'RUNNING' },
            ]);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'returned true (suppressed, not error)');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'scaleUp NOT called');
            assert.equal(cloudManager.getInstances.mock.calls.length, 1, 'cloud check was performed');
        });

        test('cloud guard counts PROVISIONING instances as running', async () => {
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 2, maxDesired: 2 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            cloudManager.getInstances.mock.mockImplementationOnce(() => [
                { instanceId: 'i-1', displayName: 'inst-1', cloudStatus: 'RUNNING' },
                { instanceId: 'i-2', displayName: 'inst-2', cloudStatus: 'PROVISIONING' },
            ]);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'returned true (suppressed)');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'scaleUp NOT called');
        });

        test('effectiveCount uses correct quantity for scale-up', async () => {
            // tracked=1, untracked=2, desired=5, maxDesired=5
            // effectiveCount = 3, should launch 2 (5 - 3)
            const groupDetailsDesired5 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 5, maxDesired: 5 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired5);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 2);
            // Cloud check allows launch
            cloudManager.getInstances.mock.mockImplementationOnce(() => [
                { instanceId: 'i-1', displayName: 'inst-1', cloudStatus: 'RUNNING' },
            ]);
            cloudManager.scaleUp.mock.mockImplementationOnce(() => 2);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch succeeded');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            // The quantity should be desiredCount - effectiveCount = 5 - 3 = 2
            assert.equal(cloudManager.scaleUp.mock.calls[0].arguments[3], 2, 'correct scale-up quantity');
        });
        test('cloud guard grace=0 full suppress (backward compat)', async () => {
            const groupDetailsDesired2 = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 2,
                    maxDesired: 2,
                    cloudGuardGraceCount: 0,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired2);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            cloudManager.getInstances.mock.mockImplementationOnce(() => [
                { instanceId: 'i-1', displayName: 'inst-1', cloudStatus: 'RUNNING' },
                { instanceId: 'i-2', displayName: 'inst-2', cloudStatus: 'RUNNING' },
            ]);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'returned true (suppressed)');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'scaleUp NOT called');
        });

        test('cloud guard grace allows limited launch', async () => {
            // tracked=1, untracked=0, desired=2, maxDesired=5, cloud=2, grace=2
            // cloudRunning(2) >= desired(2) → guard fires
            // graceLimit = 2 + 2 = 4, cloudRunning(2) < 4 → grace allows
            // graceRemaining = 4 - 2 = 2, actualScaleUpQuantity = min(1, 2) = 1
            const groupDetailsGrace = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 2,
                    maxDesired: 5,
                    cloudGuardGraceCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsGrace);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            cloudManager.getInstances.mock.mockImplementationOnce(() => [
                { instanceId: 'i-1', displayName: 'inst-1', cloudStatus: 'RUNNING' },
                { instanceId: 'i-2', displayName: 'inst-2', cloudStatus: 'RUNNING' },
            ]);
            cloudManager.scaleUp.mock.mockImplementationOnce(() => 1);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch succeeded');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            assert.equal(cloudManager.scaleUp.mock.calls[0].arguments[3], 1, 'scale-up quantity capped');
        });

        test('cloud guard grace fully consumed suppresses launch', async () => {
            // tracked=1, untracked=0, desired=2, maxDesired=5, cloud=4, grace=2
            // cloudRunning(4) >= desired(2) → guard fires
            // graceLimit = 2 + 2 = 4, cloudRunning(4) >= 4 → full suppress
            const groupDetailsGrace = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 2,
                    maxDesired: 5,
                    cloudGuardGraceCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsGrace);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            cloudManager.getInstances.mock.mockImplementationOnce(() =>
                Array.from({ length: 4 }, (_, i) => ({
                    instanceId: `i-${i}`,
                    displayName: `inst-${i}`,
                    cloudStatus: 'RUNNING',
                })),
            );

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'returned true (suppressed)');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'scaleUp NOT called');
        });

        test('cloud guard grace partially consumed caps launch quantity', async () => {
            // tracked=1, untracked=0, desired=3, maxDesired=6, cloud=4, grace=3
            // actualScaleUpQuantity = min(6, 3) - 1 = 2
            // cloudRunning(4) >= desired(3) → guard fires
            // graceLimit = 3 + 3 = 6, cloudRunning(4) < 6 → grace allows
            // graceRemaining = 6 - 4 = 2, actualScaleUpQuantity = min(2, 2) = 2
            const groupDetailsGrace = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 3,
                    maxDesired: 6,
                    cloudGuardGraceCount: 3,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsGrace);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            cloudManager.getInstances.mock.mockImplementationOnce(() =>
                Array.from({ length: 4 }, (_, i) => ({
                    instanceId: `i-${i}`,
                    displayName: `inst-${i}`,
                    cloudStatus: 'RUNNING',
                })),
            );
            cloudManager.scaleUp.mock.mockImplementationOnce(() => 2);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch succeeded');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            assert.equal(cloudManager.scaleUp.mock.calls[0].arguments[3], 2, 'scale-up quantity correct');
        });

        test('no grace needed when cloud < desired', async () => {
            // tracked=1, untracked=0, desired=5, maxDesired=5, cloud=3, grace=2
            // cloudRunning(3) < desired(5) → guard doesn't fire, normal launch
            const groupDetailsGrace = {
                ...groupDetails,
                scalingOptions: {
                    ...groupDetails.scalingOptions,
                    desiredCount: 5,
                    maxDesired: 5,
                    cloudGuardGraceCount: 2,
                },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsGrace);
            metricsLoop.getUnTrackedCount.mock.mockImplementationOnce(() => 0);
            cloudManager.getInstances.mock.mockImplementationOnce(() =>
                Array.from({ length: 3 }, (_, i) => ({
                    instanceId: `i-${i}`,
                    displayName: `inst-${i}`,
                    cloudStatus: 'RUNNING',
                })),
            );
            cloudManager.scaleUp.mock.mockImplementationOnce(() => 4);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'launch succeeded');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 1, 'scaleUp called');
            assert.equal(cloudManager.scaleUp.mock.calls[0].arguments[3], 4, 'full scale-up quantity');
        });
    });

    describe('instanceLauncher scaleDown selection tests', () => {
        test('getStatusMetricForScaleDown should give correct status', async () => {
            const result = await instanceLauncher.getStatusMetricForScaleDown(inventory[0]);
            assert.equal(result, inventory[0].status.stats.participants, 'participant count from inventory');
        });

        test('getRunningInstances should return instance', async () => {
            const result = await instanceLauncher.getRunningInstances(inventory);
            assert.equal(result.length, inventory.length, 'all instances running');
        });

        test('getInstancesForScaleDown should return empty array if no instances', async () => {
            const result = await instanceLauncher.getInstancesForScaleDown(context, [], groupDetails);
            assert.equal(result.length, 0, 'no instances to scale down');
        });

        test('getInstancesForScaleDown should select inventory item if present', async () => {
            const result = await instanceLauncher.getInstancesForScaleDown(context, inventory, groupDetailsDesired0);
            assert.equal(result.length, 1, 'should select existing instance');
        });

        test('filterOutProtectedInstances should return identical array by default', async () => {
            const result = await instanceLauncher.filterOutProtectedInstances(context, groupDetailsDesired0, inventory);
            assert.equal(result.length, inventory.length, 'no instances protected by default');
        });

        test('filterOutProtectedInstances should return blank array if instance is protected', async () => {
            shutdownManager.areScaleDownProtected.mock.mockImplementationOnce(() => [true]);
            const result = await instanceLauncher.filterOutProtectedInstances(context, groupDetailsDesired0, inventory);
            assert.equal(result.length, 0, 'no instances unprotected');
        });

        test('getInstancesForScaleDown should return empty array if only instance is protected', async () => {
            shutdownManager.areScaleDownProtected.mock.mockImplementationOnce(() => [true]);
            const result = await instanceLauncher.getInstancesForScaleDown(context, inventory, groupDetailsDesired0);
            assert.equal(result.length, 0, 'no instances unprotected');
        });

        test('getInstancesForScaleDown should select the instance that has fewer participants', async () => {
            const inventoryProvisioning = [
                ...inventory,
                {
                    instanceId: 'i-deadbeef008',
                    metadata: { group: groupName },
                    status: { provisioning: false, stats: { stress_level: 0, participants: 0 } },
                },
            ];
            const result = await instanceLauncher.getInstancesForScaleDown(
                context,
                inventoryProvisioning,
                groupDetails,
            );
            assert.equal(result.length, 1, '1 instance selected for shutdown');
            assert.equal(result[0].instanceId, 'i-deadbeef008', 'correct instance selected');
        });

        test('getInstancesForScaleDown should select the instances that have fewer participants', async () => {
            const inventoryProvisioning = [
                ...inventory,
                {
                    instanceId: 'i-deadbeef008',
                    metadata: { group: groupName },
                    status: { provisioning: false, stats: { stress_level: 0, participants: 0 } },
                },
                {
                    instanceId: 'i-deadbeef001',
                    metadata: { group: groupName },
                    status: { provisioning: false, stats: { stress_level: 0.9, participants: 100 } },
                },
            ];
            const result = await instanceLauncher.getInstancesForScaleDown(
                context,
                inventoryProvisioning,
                groupDetails,
            );
            assert.equal(result.length, 2, '2 instance selected for shutdown');
            const instanceIds = result.map((v) => v.instanceId);
            assert.ok(instanceIds.includes('i-deadbeef008'), 'one correct instance selected');
            assert.ok(instanceIds.includes('i-deadbeef007'), 'one correct instance selected');
            assert.ok(!instanceIds.includes('i-deadbeef001'), 'loaded instance not selected');
        });

        test('getInstancesForScaleDown should skip protected but still select the instances that have fewer participants', async () => {
            shutdownManager.areScaleDownProtected.mock.mockImplementationOnce((_ctx, _group, instanceIds) => {
                return instanceIds.map((v) => v === 'i-deadbeef008');
            });

            const inventoryProvisioning = [
                ...inventory,
                {
                    instanceId: 'i-deadbeef008',
                    metadata: { group: groupName },
                    status: { provisioning: false, stats: { stress_level: 0, participants: 0 } },
                },
                {
                    instanceId: 'i-deadbeef001',
                    metadata: { group: groupName },
                    status: { provisioning: false, stats: { stress_level: 0.9, participants: 100 } },
                },
            ];
            const result = await instanceLauncher.getInstancesForScaleDown(
                context,
                inventoryProvisioning,
                groupDetails,
            );
            assert.equal(result.length, 2, '2 instance selected for shutdown');
            const instanceIds = result.map((v) => v.instanceId);
            assert.ok(instanceIds.includes('i-deadbeef001'), 'one correct instance selected');
            assert.ok(instanceIds.includes('i-deadbeef007'), 'one correct instance selected');
            assert.ok(!instanceIds.includes('i-deadbeef008'), 'loaded instance not selected');
        });
    });
});
