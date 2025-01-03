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

    const inventory = [{ instanceId: 'i-deadbeef007', status: { stats: { stress_level: 0.5, participants: 1 } } }];

    const instanceGroupManager = {
        getInstanceGroup: mock.fn(() => groupDetails),
        isScaleDownProtected: mock.fn(() => false),
    };

    const cloudManager = {
        scaleUp: mock.fn(() => groupDetails.scalingOptions.scaleUpQuantity),
        scaleDown: mock.fn(),
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

    afterEach(() => {
        audit.updateLastLauncherRun.mock.resetCalls();
        instanceTracker.trimCurrent.mock.resetCalls();
        shutdownManager.areScaleDownProtected.mock.resetCalls();
        cloudManager.scaleDown.mock.resetCalls();
        cloudManager.scaleUp.mock.resetCalls();
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
            assert.equal(context.logger.info.mock.calls.length, 1, 'logger.info called');
            assert.equal(
                context.logger.info.mock.calls[0].arguments[0],
                '[Launcher] No scaling activity needed for group group with 1 instances.',
            );
        });

        // now test if scaleDown occurs with desired of 0 and inventory of 1
        test('launchOrShutdownInstancesByGroup should return true if desired is 0 and inventory is 1', async () => {
            const groupDetailsDesired0 = {
                ...groupDetails,
                scalingOptions: { ...groupDetails.scalingOptions, desiredCount: 0, minDesired: 0 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => groupDetailsDesired0);

            const result = await instanceLauncher.launchOrShutdownInstancesByGroup(context, groupName);
            assert.equal(result, true, 'scaleDown desired=0 and inventory=1');
            assert.equal(audit.updateLastLauncherRun.mock.calls.length, 1, 'audit.updateLastLauncherRun called');
            assert.equal(instanceTracker.trimCurrent.mock.calls.length, 1, 'trimCurrent called');
            assert.equal(cloudManager.scaleUp.mock.calls.length, 0, 'no scaleUp');
            assert.equal(cloudManager.scaleDown.mock.calls.length, 1, 'scaleDown called');
            assert.equal(shutdownManager.areScaleDownProtected.mock.calls.length, 1, 'areScaleDownProtected called');
            assert.equal(context.logger.info.mock.calls.length, 1, 'logger.info called');
            assert.equal(
                context.logger.info.mock.calls[0].arguments[0],
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
            assert.equal(context.logger.info.mock.calls.length, 1, 'logger.info called');
            assert.equal(
                context.logger.info.mock.calls[0].arguments[0],
                '[Launcher] Will scale up to the desired count',
            );
        });
    });
});
