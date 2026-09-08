/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import { InstanceTracker } from '../instance_tracker';
import { mockStore } from './mock_store';

describe('InstanceTracker', () => {
    let context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const shutdownManager = {
        shutdown: mock.fn(),
    };

    const audit = {
        log: mock.fn(),
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
            scaleUpThreshold: 0.8,
            scaleDownThreshold: 0.3,
            scalePeriod: 60,
            scaleUpPeriodsCount: 2,
            scaleDownPeriodsCount: 2,
        },
    };

    const instanceTracker = new InstanceTracker({
        instanceStore: mockStore,
        metricsStore: mockStore,
        shutdownManager,
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
    });

    // these tests are increase frequency metrics
    describe('trackerMetricHighFrequencyInventoryTests', () => {
        const hfGroupDetails = {
            ...groupDetails,
            scalingOptions: {
                ...groupDetails.scalingOptions,
                scalePeriod: 10,
            },
        };

        test('should segment the metrics into periods', async () => {
            const metricInventory = [
                { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 350 },
                {
                    value: 0.4,
                    instanceId: 'i-0a1b2c3d4e5f6g7h8',
                    timestamp: Date.now() - hfGroupDetails.scalingOptions.scalePeriod * 1000 - 350,
                },
            ];

            const scalePeriods = Math.max(
                hfGroupDetails.scalingOptions.scaleDownPeriodsCount,
                hfGroupDetails.scalingOptions.scaleUpPeriodsCount,
            );
            mockStore.fetchInstanceMetrics.mock.mockImplementationOnce(() => metricInventory);

            const metricInventoryPerPeriod = await instanceTracker.getMetricInventoryPerPeriod(
                context,
                hfGroupDetails,
                scalePeriods,
                hfGroupDetails.scalingOptions.scalePeriod,
            );

            // metrics for the instance should be segmented into correct count of periods
            assert.deepEqual(metricInventoryPerPeriod.length, scalePeriods);
        });

        test('should segment the metrics into periods even if gaps exist in metrics', async () => {
            const metricInventory = [
                { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 350 },
                {
                    value: 0.4,
                    instanceId: 'i-0a1b2c3d4e5f6g7h8',
                    timestamp: Date.now() - 2 * hfGroupDetails.scalingOptions.scalePeriod * 1000 - 350,
                },
            ];
            const scalePeriods = Math.max(
                hfGroupDetails.scalingOptions.scaleDownPeriodsCount,
                hfGroupDetails.scalingOptions.scaleUpPeriodsCount,
            );
            mockStore.fetchInstanceMetrics.mock.mockImplementationOnce(() => metricInventory);

            const metricInventoryPerPeriod = await instanceTracker.getMetricInventoryPerPeriod(
                context,
                hfGroupDetails,
                scalePeriods,
                hfGroupDetails.scalingOptions.scalePeriod,
            );
            // metrics for the instance should be segmented into correct count of periods
            assert.deepEqual(metricInventoryPerPeriod.length, scalePeriods);
        });

        test('should extend previous values through the metrics into periods that are missing', async () => {
            const metricInventory = [
                {
                    value: 0.4,
                    instanceId: 'i-0a1b2c3d4e5f6g7h8',
                    timestamp: Date.now() - hfGroupDetails.scalingOptions.scalePeriod * 1000 - 350,
                },
            ];
            const scalePeriods = Math.max(
                hfGroupDetails.scalingOptions.scaleDownPeriodsCount,
                hfGroupDetails.scalingOptions.scaleUpPeriodsCount,
            );
            mockStore.fetchInstanceMetrics.mock.mockImplementationOnce(() => metricInventory);

            const metricInventoryPerPeriod = await instanceTracker.getMetricInventoryPerPeriod(
                context,
                hfGroupDetails.name,
                scalePeriods,
                hfGroupDetails.scalingOptions.scalePeriod,
            );
            // metrics for the instance should be segmented into correct count of periods
            assert.deepEqual(metricInventoryPerPeriod.length, scalePeriods);

            // all periods should include a value
            metricInventoryPerPeriod.map((period) => {
                assert.deepEqual(period.length, 1);
            });

            assert.deepEqual(
                context.logger.info.mock.calls[0].arguments[0],
                `Filling in for missing metric from previous period`,
            );
            assert.deepEqual(context.logger.info.mock.calls[0].arguments[1], {
                group: groupName,
                instanceId: 'i-0a1b2c3d4e5f6g7h8',
                periodIdx: 0,
                previousMetric: metricInventory[0],
            });
        });
    });

    // these tests are for the getMetricInventoryPerPeriod method
    describe('trackerMetricInventoryTests', () => {
        test('should segment the metrics into periods', async () => {
            const metricInventory = [
                { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 1000 },
                {
                    value: 0.4,
                    instanceId: 'i-0a1b2c3d4e5f6g7h8',
                    timestamp: Date.now() - groupDetails.scalingOptions.scalePeriod * 1000 - 1000,
                },
            ];
            const scalePeriods = Math.max(
                groupDetails.scalingOptions.scaleDownPeriodsCount,
                groupDetails.scalingOptions.scaleUpPeriodsCount,
            );
            mockStore.fetchInstanceMetrics.mock.mockImplementationOnce(() => metricInventory);
            const metricInventoryPerPeriod = await instanceTracker.getMetricInventoryPerPeriod(
                context,
                groupDetails,
                scalePeriods,
                groupDetails.scalingOptions.scalePeriod,
            );

            // metrics for the instance should be segmented into correct count of periods
            assert.deepEqual(metricInventoryPerPeriod.length, scalePeriods);
        });

        test('should ignore older metrics and only consider the correct number of periods', async () => {
            const metricInventory = [
                { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 1000 },
                {
                    value: 0.4,
                    instanceId: 'i-0a1b2c3d4e5f6g7h8',
                    timestamp: Date.now() - groupDetails.scalingOptions.scalePeriod * 1000 - 1000,
                },
                {
                    value: 0.4,
                    instanceId: 'i-0a1b2c3d4e5f6g7h8',
                    timestamp: Date.now() - 2 * groupDetails.scalingOptions.scalePeriod * 1000 - 1000,
                },
            ];
            const scalePeriods = Math.max(
                groupDetails.scalingOptions.scaleDownPeriodsCount,
                groupDetails.scalingOptions.scaleUpPeriodsCount,
            );
            mockStore.fetchInstanceMetrics.mock.mockImplementationOnce(() => metricInventory);
            const metricInventoryPerPeriod = await instanceTracker.getMetricInventoryPerPeriod(
                context,
                groupDetails,
                scalePeriods,
                groupDetails.scalingOptions.scalePeriod,
            );

            // metrics for the instance should be segmented into correct count of periods
            assert.deepEqual(metricInventoryPerPeriod.length, scalePeriods);

            // the oldest metric in results should match the second-oldest metric in the inventory
            assert.deepEqual(metricInventoryPerPeriod.pop().pop().timestamp, metricInventory[1].timestamp);
        });

        test('should include a value for each instance in each period', async () => {
            const instanceId = 'i-0a1b2c3d4e5f6g7h8';
            const metricInventory = [
                { value: 0.5, instanceId, timestamp: Date.now() - 1000 },
                {
                    value: 0.4,
                    instanceId,
                    timestamp: Date.now() - groupDetails.scalingOptions.scalePeriod * 1000 - 1000,
                },
            ];
            const scalePeriods = Math.max(
                groupDetails.scalingOptions.scaleDownPeriodsCount,
                groupDetails.scalingOptions.scaleUpPeriodsCount,
            );

            mockStore.fetchInstanceMetrics.mock.mockImplementationOnce(() => metricInventory);
            const metricInventoryPerPeriod = await instanceTracker.getMetricInventoryPerPeriod(
                context,
                groupDetails,
                scalePeriods,
                groupDetails.scalingOptions.scalePeriod,
            );

            // metrics for the instance should be segmented into 2 periods
            assert.deepEqual(metricInventoryPerPeriod.length, scalePeriods);

            // each period should have a value for the instance
            assert.deepEqual(
                metricInventoryPerPeriod.filter((item) => {
                    return item.filter((i) => i.instanceId === instanceId).length > 0;
                }).length,
                metricInventoryPerPeriod.length,
            );
        });
    });

    // these tests are for the getSummaryMetricPerPeriod method
    describe('trackerSummaryTests', () => {
        test('should return the correct summary for average values', async () => {
            // two timestamps are 5 seconds ago and 61 seconds ago
            const metricInventoryPerPeriod = [
                [{ value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 5000 }],
                [{ value: 0.4, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 61000 }],
            ];
            const periodCount = metricInventoryPerPeriod.length;

            const results = await instanceTracker.getSummaryMetricPerPeriod(
                context,
                groupDetails,
                metricInventoryPerPeriod,
                periodCount,
            );

            //summary should average the values
            assert.deepEqual(results, [0.5, 0.4]);
        });
        test('should return aggregated value per instance per period', async () => {
            // two timestamps are 5 seconds ago and 61 seconds ago
            const metricInventoryPerPeriod = [
                [
                    { value: 1, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 8000 },
                    { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 5000 },
                ],
                [{ value: 0.4, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 61000 }],
            ];
            const periodCount = metricInventoryPerPeriod.length;

            const results = await instanceTracker.getSummaryMetricPerPeriod(
                context,
                groupDetails,
                metricInventoryPerPeriod,
                periodCount,
            );

            //summary should average the values
            assert.deepEqual(results, [0.75, 0.4]);
        });
        test('should first average instance metrics then average across instances', async () => {
            // two timestamps are 5 seconds ago and 61 seconds ago
            const metricInventoryPerPeriod = [
                [
                    { value: 10, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 8000 },
                    { value: 5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 5000 },
                    { value: 1, instanceId: 'i-1tst9875bbb', timestamp: Date.now() - 5500 },
                ],
                [
                    { value: 5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 61000 },
                    { value: 1, instanceId: 'i-1tst9875bbb', timestamp: Date.now() - 615000 },
                ],
            ];
            const periodCount = metricInventoryPerPeriod.length;

            const results = await instanceTracker.getSummaryMetricPerPeriod(
                context,
                groupDetails,
                metricInventoryPerPeriod,
                periodCount,
            );

            //summary should average the values of the instances first then average across instances in each period
            assert.deepEqual(results, [4.25, 3]);
        });
    });
    describe('trackerTrackTests', () => {
        const trackAudit = { log: mock.fn(), saveLatestStatus: mock.fn() };
        const trackStore = {
            saveInstanceStatus: mock.fn(() => true),
            writeInstanceMetric: mock.fn(() => true),
        };
        const tracker = new InstanceTracker({
            instanceStore: trackStore,
            metricsStore: trackStore,
            shutdownManager,
            audit: trackAudit,
        });

        function state(instanceType, status) {
            return {
                instanceId: 'i-1',
                instanceType,
                metadata: { group: groupName },
                status: { provisioning: false, ...status },
                timestamp: Date.now(),
            };
        }

        afterEach(() => {
            trackStore.saveInstanceStatus.mock.resetCalls();
            trackStore.writeInstanceMetric.mock.resetCalls();
            trackStore.saveInstanceStatus.mock.mockImplementation(() => true);
        });

        test('tracks an idle availability instance as available (1)', async () => {
            await tracker.track(context, state('availability', { jibriStatus: { busyStatus: 'IDLE' } }));
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls.length, 1);
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls[0].arguments[2].value, 1);
        });

        test('tracks a busy availability instance as unavailable (0)', async () => {
            await tracker.track(context, state('availability', { jibriStatus: { busyStatus: 'BUSY' } }));
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls.length, 1);
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls[0].arguments[2].value, 0);
        });

        test('tracks an idle jibri instance as available (1)', async () => {
            await tracker.track(context, state('jibri', { jibriStatus: { busyStatus: 'IDLE' } }));
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls[0].arguments[2].value, 1);
        });

        test('tracks stress level for a JVB instance', async () => {
            await tracker.track(context, state('JVB', { stats: { stress_level: 0.42 } }));
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls[0].arguments[2].value, 0.42);
        });

        test('does not write a metric for a NaN stress level', async () => {
            await tracker.track(context, state('JVB', { stats: { stress_level: NaN } }));
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls.length, 0);
        });

        test('does not write a metric for an unknown instance type', async () => {
            await tracker.track(context, state('mystery', {}));
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls.length, 0);
            assert.strictEqual(trackStore.saveInstanceStatus.mock.calls.length, 1);
        });

        test('rejects when the instance status cannot be persisted', async () => {
            trackStore.saveInstanceStatus.mock.mockImplementation(() => Promise.reject(new Error('store down')));
            await assert.rejects(() => tracker.track(context, state('JVB', { stats: { stress_level: 0.1 } })), {
                message: 'store down',
            });
            assert.strictEqual(trackStore.writeInstanceMetric.mock.calls.length, 0);
        });
    });

    describe('trackerNomadStatsTests', () => {
        test('returns undefined for a nomad report without gauges', () => {
            assert.strictEqual(instanceTracker.nomadStatusFromStats({ Gauges: [] }), undefined);
            assert.strictEqual(instanceTracker.nomadStatusFromStats({}), undefined);
        });

        test('returns undefined when cpu gauges are missing', () => {
            const stats = { Gauges: [{ Name: 'nomad.client.allocated.memory', Value: 1, Labels: {} }] };
            assert.strictEqual(instanceTracker.nomadStatusFromStats(stats), undefined);
        });

        test('computes stress level from cpu gauges', () => {
            const stats = {
                Gauges: [
                    {
                        Name: 'nomad.client.allocated.cpu',
                        Value: 3,
                        Labels: { node_scheduling_eligibility: 'eligible' },
                    },
                    { Name: 'nomad.client.unallocated.cpu', Value: 1, Labels: {} },
                ],
            };
            const status = instanceTracker.nomadStatusFromStats(stats);
            assert.strictEqual(status.stress_level, 0.75);
            assert.strictEqual(status.eligibleForScheduling, true);
        });

        test('summary metric for an empty period is NaN, not 0', () => {
            assert.ok(Number.isNaN(instanceTracker.computeSummaryMetric([], true)));
            assert.ok(Number.isNaN(instanceTracker.computeSummaryMetric([], false)));
        });
    });
});
