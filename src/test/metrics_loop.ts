/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { describe, mock } from 'node:test';
import * as promClient from 'prom-client';

import MetricsLoop from '../metrics_loop';
import { MockRedisClient } from './mock-redis-client';

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

async function metricValues(name) {
    const metric = promClient.register.getSingleMetric(name);
    assert.ok(metric, `metric ${name} is registered`);
    return (await metric.get()).values;
}

// Value of a labelled gauge series, or undefined when no series with that label exists.
async function gaugeValue(name, group) {
    const values = await metricValues(name);
    const entry = values.find((v) => v.labels.group === group);
    return entry ? entry.value : undefined;
}

// Value of an unlabelled gauge.
async function plainGaugeValue(name) {
    const values = await metricValues(name);
    return values.length > 0 ? values[0].value : undefined;
}

const GROUP_GAUGES = [
    'autoscaling_desired_count',
    'autoscaling_minimum_count',
    'autoscaling_maximum_count',
    'autoscaling_instance_count',
    'autoscaling_instance_running',
    'autoscaling_cloud_instance_count',
    'autoscaling_untracked_instance_count',
];

describe('MetricsLoop', () => {
    let groupCounter = 0;

    function makeGroup(name, { desiredCount = 1, minDesired = 0, maxDesired = 10 } = {}) {
        return {
            name,
            type: 'JVB',
            cloud: 'oracle',
            region: 'default',
            environment: 'test',
            scalingOptions: {
                minDesired,
                maxDesired,
                desiredCount,
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

    // Unique names per test so gauge series left in the process-wide default registry by a previous
    // test can never satisfy an assertion in a later one.
    function uniqueName(prefix) {
        groupCounter++;
        return `${prefix}-${groupCounter}`;
    }

    function state(instanceId, provisioning = false) {
        return {
            instanceId,
            instanceType: 'JVB',
            metadata: { group: 'g' },
            status: { provisioning },
            timestamp: Date.now(),
        };
    }

    function makeHarness({
        groups = [],
        inventory = {},
        cloudInstances = {},
        untracked = {},
        redisClient = new MockRedisClient(),
        metricsTTL = 600,
    } = {}) {
        const ctx = initContext();
        const instanceGroupManager = { getAllInstanceGroups: mock.fn(async () => groups) };
        const instanceTracker = { trimCurrent: mock.fn(async (_ctx, groupName) => inventory[groupName] || []) };
        const instanceStore = {
            fetchCloudInstances: mock.fn(async (_ctx, groupName) => cloudInstances[groupName] || []),
        };
        const metricsStore = {
            fetchMetricUnTrackedCount: mock.fn(async (_ctx, groupName) => untracked[groupName] || 0),
        };

        const metricsLoop = new MetricsLoop({
            redisClient,
            metricsTTL,
            instanceGroupManager,
            instanceTracker,
            instanceStore,
            metricsStore,
            ctx,
        });

        return { ctx, redisClient, instanceGroupManager, instanceTracker, instanceStore, metricsStore, metricsLoop };
    }

    describe('updateMetrics', () => {
        test('sets desired/min/max, instance, running, cloud and untracked gauges per group and the managed-groups gauge', async () => {
            const a = uniqueName('alpha');
            const b = uniqueName('beta');
            const h = makeHarness({
                groups: [
                    makeGroup(a, { desiredCount: 3, minDesired: 1, maxDesired: 5 }),
                    makeGroup(b, { desiredCount: 0, minDesired: 0, maxDesired: 2 }),
                ],
                inventory: {
                    [a]: [state('i-1'), state('i-2', true), state('i-3')],
                    [b]: [],
                },
                cloudInstances: {
                    [a]: [
                        { instanceId: 'i-1', displayName: 'i-1', cloudStatus: 'RUNNING' },
                        { instanceId: 'i-2', displayName: 'i-2', cloudStatus: 'PROVISIONING' },
                        { instanceId: 'i-3', displayName: 'i-3', cloudStatus: 'RUNNING' },
                        { instanceId: 'i-4', displayName: 'i-4', cloudStatus: 'RUNNING' },
                    ],
                },
                untracked: { [a]: 1 },
            });

            await h.metricsLoop.updateMetrics();

            assert.strictEqual(await gaugeValue('autoscaling_desired_count', a), 3);
            assert.strictEqual(await gaugeValue('autoscaling_minimum_count', a), 1);
            assert.strictEqual(await gaugeValue('autoscaling_maximum_count', a), 5);
            assert.strictEqual(await gaugeValue('autoscaling_instance_count', a), 3);
            assert.strictEqual(await gaugeValue('autoscaling_instance_running', a), 2);
            assert.strictEqual(await gaugeValue('autoscaling_cloud_instance_count', a), 4);
            assert.strictEqual(await gaugeValue('autoscaling_untracked_instance_count', a), 1);

            assert.strictEqual(await gaugeValue('autoscaling_desired_count', b), 0);
            assert.strictEqual(await gaugeValue('autoscaling_minimum_count', b), 0);
            assert.strictEqual(await gaugeValue('autoscaling_maximum_count', b), 2);
            assert.strictEqual(await gaugeValue('autoscaling_instance_count', b), 0);
            assert.strictEqual(await gaugeValue('autoscaling_instance_running', b), 0);
            assert.strictEqual(await gaugeValue('autoscaling_cloud_instance_count', b), 0);
            assert.strictEqual(await gaugeValue('autoscaling_untracked_instance_count', b), 0);

            assert.strictEqual(await plainGaugeValue('autoscaling_groups_managed'), 2);
            assert.strictEqual(h.ctx.logger.warn.mock.calls.length, 0);
        });

        test('reads cloud instances and the untracked count through the injected stores with the loop context', async () => {
            const a = uniqueName('store');
            const h = makeHarness({ groups: [makeGroup(a)] });

            await h.metricsLoop.updateMetrics();

            assert.strictEqual(h.instanceGroupManager.getAllInstanceGroups.mock.calls.length, 1);
            assert.strictEqual(h.instanceGroupManager.getAllInstanceGroups.mock.calls[0].arguments[0], h.ctx);

            assert.strictEqual(h.instanceTracker.trimCurrent.mock.calls.length, 1);
            assert.deepStrictEqual(h.instanceTracker.trimCurrent.mock.calls[0].arguments, [h.ctx, a]);

            assert.strictEqual(h.instanceStore.fetchCloudInstances.mock.calls.length, 1);
            assert.deepStrictEqual(h.instanceStore.fetchCloudInstances.mock.calls[0].arguments, [h.ctx, a]);

            assert.strictEqual(h.metricsStore.fetchMetricUnTrackedCount.mock.calls.length, 1);
            assert.deepStrictEqual(h.metricsStore.fetchMetricUnTrackedCount.mock.calls[0].arguments, [h.ctx, a]);
        });

        test('publishes the queue waiting count previously saved by the job manager', async () => {
            const a = uniqueName('queue');
            const h = makeHarness({ groups: [makeGroup(a)] });
            await h.metricsLoop.saveMetricQueueWaiting(7);

            await h.metricsLoop.updateMetrics();

            assert.strictEqual(await plainGaugeValue('autoscaling_queue_waiting'), 7);
        });

        test('removes gauge series for groups that no longer exist and keeps the remaining ones', async () => {
            const keep = uniqueName('keep');
            const gone = uniqueName('gone');
            const groups = [makeGroup(keep, { desiredCount: 2 }), makeGroup(gone, { desiredCount: 4 })];
            const h = makeHarness({
                groups,
                inventory: { [gone]: [state('i-1')] },
                cloudInstances: { [gone]: [{ instanceId: 'i-1', displayName: 'i-1', cloudStatus: 'RUNNING' }] },
                untracked: { [gone]: 0 },
            });

            await h.metricsLoop.updateMetrics();
            for (const name of GROUP_GAUGES) {
                assert.notStrictEqual(await gaugeValue(name, gone), undefined, `${name} populated for ${gone}`);
            }

            // the group is deleted between cycles
            h.instanceGroupManager.getAllInstanceGroups.mock.mockImplementation(async () => [groups[0]]);
            await h.metricsLoop.updateMetrics();

            for (const name of GROUP_GAUGES) {
                assert.strictEqual(await gaugeValue(name, gone), undefined, `${name} series removed for ${gone}`);
            }
            assert.strictEqual(await gaugeValue('autoscaling_desired_count', keep), 2);
            assert.strictEqual(await plainGaugeValue('autoscaling_groups_managed'), 1);
            assert.ok(
                h.ctx.logger.info.mock.calls.some((c) =>
                    c.arguments[0].includes(`Deleted invalid metrics group label ${gone}`),
                ),
            );
        });

        test('only forgets labels it has itself seen (a fresh loop does not touch series from other sources)', async () => {
            const foreign = uniqueName('foreign');
            const mine = uniqueName('mine');
            const seed = makeHarness({ groups: [makeGroup(foreign, { desiredCount: 9 })] });
            await seed.metricsLoop.updateMetrics();

            const h = makeHarness({ groups: [makeGroup(mine)] });
            await h.metricsLoop.updateMetrics();

            assert.strictEqual(await gaugeValue('autoscaling_desired_count', foreign), 9);
            assert.strictEqual(await gaugeValue('autoscaling_desired_count', mine), 1);
        });

        test('a group whose inventory lookup rejects is warned about by name and the other groups are still updated', async () => {
            const a = uniqueName('ok');
            const b = uniqueName('broken');
            const h = makeHarness({
                groups: [makeGroup(b), makeGroup(a, { desiredCount: 4 })],
                inventory: { [a]: [state('i-1'), state('i-2')] },
                cloudInstances: { [a]: [{ instanceId: 'i-1', displayName: 'i-1', cloudStatus: 'RUNNING' }] },
                untracked: { [a]: 3 },
            });
            const failure = new Error('redis timeout');
            h.instanceTracker.trimCurrent.mock.mockImplementation(async (_ctx, groupName) => {
                if (groupName === b) {
                    throw failure;
                }
                return [state('i-1'), state('i-2')];
            });

            await assert.doesNotReject(h.metricsLoop.updateMetrics());

            // the sibling group's per-group gauges were still set despite the failure of the first group
            assert.strictEqual(await gaugeValue('autoscaling_desired_count', a), 4);
            assert.strictEqual(await gaugeValue('autoscaling_instance_count', a), 2);
            assert.strictEqual(await gaugeValue('autoscaling_instance_running', a), 2);
            assert.strictEqual(await gaugeValue('autoscaling_cloud_instance_count', a), 1);
            assert.strictEqual(await gaugeValue('autoscaling_untracked_instance_count', a), 3);
            assert.strictEqual(await plainGaugeValue('autoscaling_groups_managed'), 2);

            // exactly one warn, naming the failing group, carrying the error
            assert.strictEqual(h.ctx.logger.warn.mock.calls.length, 1);
            const [message, meta] = h.ctx.logger.warn.mock.calls[0].arguments;
            assert.ok(message.includes(b), `warn names the failing group: ${message}`);
            assert.ok(message.includes('redis timeout'), `warn carries the error: ${message}`);
            assert.ok(!message.includes(a), 'warn does not blame the healthy group');
            assert.strictEqual(meta.err, failure);
            assert.strictEqual(meta.group, b);
            // the synchronous gauges for the broken group were still set before the rejection
            assert.strictEqual(await gaugeValue('autoscaling_desired_count', b), 1);
        });

        test('each failing group gets its own warn; siblings are not hidden behind the first rejection', async () => {
            const a = uniqueName('ok');
            const b = uniqueName('broken');
            const c = uniqueName('also-broken');
            const h = makeHarness({ groups: [makeGroup(b), makeGroup(c), makeGroup(a)] });
            h.instanceTracker.trimCurrent.mock.mockImplementation(async (_ctx, groupName) => {
                if (groupName === b || groupName === c) {
                    throw new Error(`boom ${groupName}`);
                }
                return [];
            });

            await assert.doesNotReject(h.metricsLoop.updateMetrics());

            assert.strictEqual(h.ctx.logger.warn.mock.calls.length, 2);
            const warned = h.ctx.logger.warn.mock.calls.map((call) => call.arguments[1].group).sort();
            assert.deepStrictEqual(warned, [b, c].sort());
            assert.strictEqual(await gaugeValue('autoscaling_instance_count', a), 0);
        });

        test('sets autoscaling_groups_managed to 0 when the last group has been deleted', async () => {
            const a = uniqueName('last');
            const groups = [makeGroup(a)];
            const h = makeHarness({ groups });

            await h.metricsLoop.updateMetrics();
            assert.strictEqual(await plainGaugeValue('autoscaling_groups_managed'), 1);

            h.instanceGroupManager.getAllInstanceGroups.mock.mockImplementation(async () => []);
            await h.metricsLoop.updateMetrics();

            assert.strictEqual(await plainGaugeValue('autoscaling_groups_managed'), 0);
            assert.strictEqual(h.ctx.logger.warn.mock.calls.length, 0);
        });

        test('a rejected store read is caught and logged; updateMetrics resolves', async () => {
            const a = uniqueName('storefail');
            const h = makeHarness({ groups: [makeGroup(a)] });
            h.metricsStore.fetchMetricUnTrackedCount.mock.mockImplementation(async () => {
                throw new Error('prometheus unreachable');
            });

            await assert.doesNotReject(h.metricsLoop.updateMetrics());

            assert.strictEqual(h.ctx.logger.warn.mock.calls.length, 1);
            assert.ok(h.ctx.logger.warn.mock.calls[0].arguments[0].includes('prometheus unreachable'));
            assert.ok(h.ctx.logger.warn.mock.calls[0].arguments[0].includes(a), 'warn names the failing group');
        });

        test('a failing group listing is caught and logged without touching any gauge', async () => {
            const h = makeHarness();
            h.instanceGroupManager.getAllInstanceGroups.mock.mockImplementation(async () => {
                throw new Error('store down');
            });

            await assert.doesNotReject(h.metricsLoop.updateMetrics());

            assert.strictEqual(h.instanceTracker.trimCurrent.mock.calls.length, 0);
            assert.strictEqual(h.ctx.logger.warn.mock.calls.length, 1);
            assert.ok(h.ctx.logger.warn.mock.calls[0].arguments[0].includes('store down'));
        });
    });

    describe('countNonProvisioningInstances', () => {
        test('counts only instances whose status is not provisioning', () => {
            const h = makeHarness();
            const states = [state('i-1'), state('i-2', true), state('i-3'), state('i-4', true)];
            assert.strictEqual(h.metricsLoop.countNonProvisioningInstances(h.ctx, states), 2);
            assert.strictEqual(h.metricsLoop.countNonProvisioningInstances(h.ctx, []), 0);
        });
    });

    describe('queue waiting round trip', () => {
        test('saveMetricQueueWaiting stores the count with the metrics TTL and getQueueWaitingCount reads it back', async () => {
            const h = makeHarness({ metricsTTL: 120 });

            const saved = await h.metricsLoop.saveMetricQueueWaiting(5);

            assert.strictEqual(saved, true);
            assert.strictEqual(await h.redisClient.get('service-metrics:queue-waiting'), '5');
            const ttl = await h.redisClient.ttl('service-metrics:queue-waiting');
            assert.ok(ttl > 0 && ttl <= 120, `ttl ${ttl} within metricsTTL`);
            assert.strictEqual(await h.metricsLoop.getQueueWaitingCount(), 5);
        });

        test('getQueueWaitingCount returns 0 when nothing has been saved or the value is unparsable', async () => {
            const h = makeHarness();
            assert.strictEqual(await h.metricsLoop.getQueueWaitingCount(), 0);

            await h.redisClient.set('service-metrics:queue-waiting', 'not-a-number');
            assert.strictEqual(await h.metricsLoop.getQueueWaitingCount(), 0);

            await h.redisClient.set('service-metrics:queue-waiting', '');
            assert.strictEqual(await h.metricsLoop.getQueueWaitingCount(), 0);
        });

        test('later saves overwrite earlier ones', async () => {
            const h = makeHarness();
            await h.metricsLoop.saveMetricQueueWaiting(3);
            await h.metricsLoop.saveMetricQueueWaiting(0);
            assert.strictEqual(await h.metricsLoop.getQueueWaitingCount(), 0);
        });

        test('setValue throws when redis does not acknowledge the write', async () => {
            const redisClient = { set: mock.fn(async () => null), get: mock.fn(async () => null) };
            const h = makeHarness({ redisClient });

            await assert.rejects(
                h.metricsLoop.saveMetricQueueWaiting(1),
                /unable to set service-metrics:queue-waiting/,
            );
            assert.deepStrictEqual(redisClient.set.mock.calls[0].arguments, [
                'service-metrics:queue-waiting',
                '1',
                'EX',
                600,
            ]);
        });
    });

    describe('store delegation', () => {
        test('getUnTrackedCount and getCloudInstances delegate to the metrics and instance stores', async () => {
            const a = uniqueName('delegate');
            const cloud = [{ instanceId: 'i-1', displayName: 'i-1', cloudStatus: 'RUNNING' }];
            const h = makeHarness({ cloudInstances: { [a]: cloud }, untracked: { [a]: 4 } });

            assert.strictEqual(await h.metricsLoop.getUnTrackedCount(a), 4);
            assert.strictEqual(await h.metricsLoop.getCloudInstances(a), cloud);
            assert.deepStrictEqual(h.metricsStore.fetchMetricUnTrackedCount.mock.calls[0].arguments, [h.ctx, a]);
            assert.deepStrictEqual(h.instanceStore.fetchCloudInstances.mock.calls[0].arguments, [h.ctx, a]);
        });
    });
});
