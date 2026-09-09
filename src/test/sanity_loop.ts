/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { describe, mock } from 'node:test';

import SanityLoop from '../sanity_loop';
import GroupReportGenerator from '../group_report';

function initContext() {
    return {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };
}

describe('SanityLoop', () => {
    const groupName = 'jvb-group';
    const group = {
        name: groupName,
        type: 'JVB',
        cloud: 'oracle',
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
            maxDesired: 5,
            desiredCount: 2,
            scaleUpQuantity: 1,
            scaleDownQuantity: 1,
            scaleUpThreshold: 0.8,
            scaleDownThreshold: 0.3,
            scalePeriod: 60,
            scaleUpPeriodsCount: 2,
            scaleDownPeriodsCount: 2,
        },
    };

    const retryStrategy = {
        maxTimeInSeconds: 30,
        maxDelayInSeconds: 10,
        retryableStatusCodes: [429, 500, 503],
    };

    function trackedState(instanceId, overrides = {}) {
        return {
            instanceId,
            instanceType: 'JVB',
            metadata: { group: groupName, name: `${instanceId}-name` },
            status: { provisioning: false },
            timestamp: Date.now(),
            ...overrides,
        };
    }

    function cloudInstance(instanceId, cloudStatus = 'RUNNING') {
        return { instanceId, displayName: `${instanceId}-display`, cloudStatus };
    }

    // The real GroupReportGenerator is used so the untracked count is computed by the production
    // code path (cloud instances that are provisioning/running but have no tracked state).
    function makeHarness({ trackedStates = [], cloudInstances = [], groupFound = true } = {}) {
        const ctx = initContext();

        const instanceTracker = { trimCurrent: mock.fn(async () => trackedStates) };
        const shutdownManager = {
            getShutdownStatuses: mock.fn(async (_ctx, _group, ids) => ids.map(() => false)),
            getShutdownConfirmations: mock.fn(async (_ctx, _group, ids) => ids.map(() => false)),
            areScaleDownProtected: mock.fn(async (_ctx, _group, ids) => ids.map(() => false)),
        };
        const reconfigureManager = {
            getReconfigureDates: mock.fn(async (_ctx, _group, ids) => ids.map(() => '')),
        };
        const metricsLoop = { getCloudInstances: mock.fn(async () => []) };
        const groupReportGenerator = new GroupReportGenerator({
            instanceTracker,
            shutdownManager,
            reconfigureManager,
            metricsLoop,
        });
        const generateReportSpy = mock.method(groupReportGenerator, 'generateReport');

        const cloudManager = { getInstances: mock.fn(async () => cloudInstances) };
        const instanceGroupManager = { getInstanceGroup: mock.fn(async () => (groupFound ? group : undefined)) };
        const instanceStore = { saveCloudInstances: mock.fn(async () => true) };
        const metricsStore = { saveMetricUnTrackedCount: mock.fn(async () => true) };

        const sanityLoop = new SanityLoop({
            metricsStore,
            instanceStore,
            cloudManager,
            reportExtCallRetryStrategy: retryStrategy,
            groupReportGenerator,
            instanceGroupManager,
        });

        return {
            ctx,
            sanityLoop,
            cloudManager,
            instanceGroupManager,
            instanceStore,
            metricsStore,
            instanceTracker,
            metricsLoop,
            generateReportSpy,
        };
    }

    describe('reportUntrackedInstances', () => {
        test('fetches cloud instances for the group with the report retry strategy and saves them via the instance store', async () => {
            const cloud = [cloudInstance('i-1'), cloudInstance('i-2')];
            const h = makeHarness({ trackedStates: [trackedState('i-1'), trackedState('i-2')], cloudInstances: cloud });

            const result = await h.sanityLoop.reportUntrackedInstances(h.ctx, groupName);

            assert.strictEqual(result, true);
            assert.strictEqual(h.instanceGroupManager.getInstanceGroup.mock.calls.length, 1);
            assert.deepStrictEqual(h.instanceGroupManager.getInstanceGroup.mock.calls[0].arguments, [h.ctx, groupName]);

            assert.strictEqual(h.cloudManager.getInstances.mock.calls.length, 1);
            assert.deepStrictEqual(h.cloudManager.getInstances.mock.calls[0].arguments, [h.ctx, group, retryStrategy]);

            assert.strictEqual(h.instanceStore.saveCloudInstances.mock.calls.length, 1);
            const [saveCtx, saveGroup, saved] = h.instanceStore.saveCloudInstances.mock.calls[0].arguments;
            assert.strictEqual(saveCtx, h.ctx);
            assert.strictEqual(saveGroup, groupName);
            assert.strictEqual(saved, cloud);

            // the report is generated from the freshly fetched list, not from the store
            assert.strictEqual(h.generateReportSpy.mock.calls.length, 1);
            assert.strictEqual(h.generateReportSpy.mock.calls[0].arguments[2], cloud);
            assert.strictEqual(h.metricsLoop.getCloudInstances.mock.calls.length, 0);
        });

        test('saves an untracked count of zero when every running cloud instance is tracked', async () => {
            const h = makeHarness({
                trackedStates: [trackedState('i-1'), trackedState('i-2')],
                cloudInstances: [cloudInstance('i-1'), cloudInstance('i-2')],
            });

            await h.sanityLoop.reportUntrackedInstances(h.ctx, groupName);

            assert.strictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls.length, 1);
            assert.deepStrictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments, [
                h.ctx,
                groupName,
                0,
            ]);
        });

        test('counts running or provisioning cloud instances with no tracked state as untracked', async () => {
            const h = makeHarness({
                trackedStates: [trackedState('i-1'), trackedState('i-4', { status: { provisioning: true } })],
                cloudInstances: [
                    cloudInstance('i-1', 'RUNNING'), // tracked
                    cloudInstance('i-2', 'RUNNING'), // untracked
                    cloudInstance('i-3', 'Provisioning'), // untracked, status compared case-insensitively
                    cloudInstance('i-4', 'RUNNING'), // tracked (still provisioning on the sidecar side)
                ],
            });

            const result = await h.sanityLoop.reportUntrackedInstances(h.ctx, groupName);

            assert.strictEqual(result, true);
            assert.deepStrictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments, [
                h.ctx,
                groupName,
                2,
            ]);
            assert.ok(
                h.ctx.logger.info.mock.calls.some((c) =>
                    c.arguments[0].includes(`saved cloud instances and untracked count 2 for ${groupName}`),
                ),
            );
        });

        test('does not count cloud instances in a non-running state (e.g. TERMINATED, STOPPED) as untracked', async () => {
            const h = makeHarness({
                trackedStates: [],
                cloudInstances: [
                    cloudInstance('i-9', 'TERMINATED'),
                    cloudInstance('i-10', 'STOPPED'),
                    cloudInstance('i-11', 'RUNNING'),
                ],
            });

            await h.sanityLoop.reportUntrackedInstances(h.ctx, groupName);

            assert.deepStrictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments, [
                h.ctx,
                groupName,
                1,
            ]);
            // the full cloud list is still persisted as-is; filtering only affects the count
            assert.strictEqual(h.instanceStore.saveCloudInstances.mock.calls[0].arguments[2].length, 3);
        });

        test('tracked instances that are gone from the cloud do not affect the untracked count', async () => {
            const h = makeHarness({
                trackedStates: [trackedState('i-1'), trackedState('i-2'), trackedState('i-3')],
                cloudInstances: [cloudInstance('i-1')],
            });

            await h.sanityLoop.reportUntrackedInstances(h.ctx, groupName);

            assert.deepStrictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments, [
                h.ctx,
                groupName,
                0,
            ]);
        });

        test('handles an empty cloud instance list', async () => {
            const h = makeHarness({ trackedStates: [trackedState('i-1')], cloudInstances: [] });

            const result = await h.sanityLoop.reportUntrackedInstances(h.ctx, groupName);

            assert.strictEqual(result, true);
            assert.deepStrictEqual(h.instanceStore.saveCloudInstances.mock.calls[0].arguments[2], []);
            assert.strictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments[2], 0);
            assert.ok(
                h.ctx.logger.info.mock.calls.some((c) =>
                    c.arguments[0].includes(`Successfully retrieved 0 oracle instances for ${groupName}`),
                ),
            );
        });

        test('returns false and touches neither the cloud nor the stores when the group does not exist', async () => {
            const h = makeHarness({ groupFound: false });

            const result = await h.sanityLoop.reportUntrackedInstances(h.ctx, 'missing-group');

            assert.strictEqual(result, false);
            assert.strictEqual(h.cloudManager.getInstances.mock.calls.length, 0);
            assert.strictEqual(h.instanceStore.saveCloudInstances.mock.calls.length, 0);
            assert.strictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls.length, 0);
            assert.strictEqual(h.generateReportSpy.mock.calls.length, 0);
            assert.ok(
                h.ctx.logger.info.mock.calls.some((c) =>
                    c.arguments[0].includes('Skipped saving untracked instances, as group is not found missing-group'),
                ),
            );
        });

        test('propagates a cloud manager failure to the caller (the job runner) without writing partial results', async () => {
            const h = makeHarness({ trackedStates: [trackedState('i-1')] });
            const cloudError = new Error('OCI 503');
            h.cloudManager.getInstances.mock.mockImplementation(async () => {
                throw cloudError;
            });

            await assert.rejects(h.sanityLoop.reportUntrackedInstances(h.ctx, groupName), cloudError);

            // nothing stale is written: neither the cloud list nor the untracked count
            assert.strictEqual(h.instanceStore.saveCloudInstances.mock.calls.length, 0);
            assert.strictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls.length, 0);
            assert.strictEqual(h.generateReportSpy.mock.calls.length, 0);
        });

        test('propagates an instance store failure and does not save the untracked count', async () => {
            const h = makeHarness({ cloudInstances: [cloudInstance('i-1')] });
            const storeError = new Error('redis write failed');
            h.instanceStore.saveCloudInstances.mock.mockImplementation(async () => {
                throw storeError;
            });

            await assert.rejects(h.sanityLoop.reportUntrackedInstances(h.ctx, groupName), storeError);

            assert.strictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls.length, 0);
        });

        test('reportUntrackedInstances is bound to the instance so it can be passed as a bare callback', async () => {
            const h = makeHarness({ cloudInstances: [cloudInstance('i-1')] });
            const detached = h.sanityLoop.reportUntrackedInstances;

            const result = await detached(h.ctx, groupName);

            assert.strictEqual(result, true);
            assert.strictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments[2], 1);
        });
    });

    describe('saveMetricUnTrackedCount', () => {
        test('delegates to the metrics store and returns its result', async () => {
            const h = makeHarness();
            h.metricsStore.saveMetricUnTrackedCount.mock.mockImplementation(async () => false);

            const result = await h.sanityLoop.saveMetricUnTrackedCount(h.ctx, groupName, 3);

            assert.strictEqual(result, false);
            assert.deepStrictEqual(h.metricsStore.saveMetricUnTrackedCount.mock.calls[0].arguments, [
                h.ctx,
                groupName,
                3,
            ]);
        });
    });
});
