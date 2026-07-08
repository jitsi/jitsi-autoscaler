/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import PrometheusClient, { PrometheusOptions } from '../prometheus';
import { Result } from 'prometheus-remote-write';

const asLogger = new AutoscalerLogger({ logLevel: 'debug' });
const logger = asLogger.createLogger('debug');

const driver = { rangeQuery: mock.fn(() => {}), query: mock.fn(() => {}) };
const writer = { pushMetrics: mock.fn(() => {}) };
const ctx = { logger };
ctx.logger.debug = mock.fn();
ctx.logger.error = mock.fn();

writer.pushMetrics = mock.fn(async (_metrics, _labels) => {
    return <Result>{
        status: 204,
        statusText: 'OK',
    };
});

driver.rangeQuery = mock.fn(
    () =>
        <Result>{
            result: [
                { metric: { labels: { instance: 'test', group: 'test' } }, values: [{ value: 0.1, time: new Date() }] },
            ],
        },
);

const options = <PrometheusOptions>{
    logger,
    endpoint: 'http://localhost:9090',
    promDriver: driver,
    promWriter: writer,
};

const client = new PrometheusClient(options);

describe('PrometheusClient', () => {
    // const context = { logger: { debug: mock.fn() } };

    afterEach(() => {
        mock.restoreAll();
    });

    describe('testWriteInstanceMetrics', () => {
        const group = 'test';
        const item = {
            value: 0.1,
            timestamp: Date.now(),
            instanceId: 'test',
        };

        test('will write metrics for the correct group', async () => {
            const res = await client.writeInstanceMetric(ctx, group, item, writer);
            assert.strictEqual(res, true);
        });

        test('will return false when errors are thrown', async () => {
            writer.pushMetrics.mock.mockImplementationOnce(() => {
                throw new Error('EXPECTED ERROR: DISREGARD');
            });
            const res = await client.writeInstanceMetric(ctx, group, item, writer);
            assert.strictEqual(res, false);
        });

        test('will return false when non-204 error code is returned', async () => {
            writer.pushMetrics.mock.mockImplementationOnce(
                () =>
                    <Result>{
                        status: 500,
                        statusText: 'EXPECTED ERROR: DISREGARD',
                    },
            );
            const res = await client.writeInstanceMetric(ctx, group, item, writer);
            assert.strictEqual(res, false);
        });
    });

    describe('testFetchInstanceMetrics', () => {
        const group = 'test';

        test('will fetch metrics for the correct group', async () => {
            const res = await client.fetchInstanceMetrics(ctx, group);
            assert.notEqual(res.length, 0);
            assert.strictEqual(res[0].instanceId, 'test');
            assert.strictEqual(res[0].value, 0.1);
        });

        // P1: a query error must propagate (rejection), not resolve to an empty [] that reads as "no metrics"
        test('will propagate errors when fetching', async () => {
            driver.rangeQuery.mock.mockImplementationOnce(() => {
                throw new Error('EXPECTED ERROR: DISREGARD');
            });
            await assert.rejects(
                () => client.fetchInstanceMetrics(ctx, group),
                'expect fetchInstanceMetrics to reject on a query error',
            );
        });

        test('will handle empty sets when fetching', async () => {
            driver.rangeQuery.mock.mockImplementationOnce(() => {
                return <Result>{ result: [] };
            });
            const res = await client.fetchInstanceMetrics(ctx, group);
            assert.strictEqual(res.length, 0);
        });

        // P2: the range query lookback must cover the requested window (scalePeriod * period count)
        test('will size the range query to at least the requested window', async () => {
            let capturedStart;
            const before = Date.now();
            driver.rangeQuery.mock.mockImplementationOnce((_query, start) => {
                capturedStart = start;
                return <Result>{ result: [] };
            });
            const windowSeconds = 300 * 24; // scalePeriod=300, scaleUpPeriodsCount=24 -> 2 hours
            await client.fetchInstanceMetrics(ctx, group, windowSeconds);
            assert.ok(
                before - capturedStart >= windowSeconds * 1000,
                `expect lookback (${before - capturedStart}ms) to be at least the window (${windowSeconds * 1000}ms)`,
            );
        });

        // P3: group names with quotes/backslashes must be escaped into the PromQL matcher
        test('will escape special characters in the group label', async () => {
            let capturedQuery;
            driver.rangeQuery.mock.mockImplementationOnce((query) => {
                capturedQuery = query;
                return <Result>{ result: [] };
            });
            await client.fetchInstanceMetrics(ctx, 'ev"il\\group');
            assert.strictEqual(
                capturedQuery,
                'autoscaler_instance_stress_level{group="ev\\"il\\\\group"}',
                'expect quote and backslash to be escaped in the query',
            );
        });
    });

    test('will save untracked count properly', async () => {
        client.saveMetricUnTrackedCount('test', 1, writer);

        driver.rangeQuery.mock.mockImplementationOnce(
            () =>
                <Result>{
                    result: [
                        {
                            metric: { labels: { instance: 'test', group: 'test' } },
                            values: [{ value: 1, time: new Date() }],
                        },
                    ],
                },
        );
        const res = await client.prometheusRangeQuery('autoscaler_untracked_instance_count{group="test"}', driver);
        assert.strictEqual(res.result[0].values[0].value, 1);
    });
});
