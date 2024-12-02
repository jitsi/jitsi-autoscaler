/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import PrometheusClient, { PrometheusOptions } from '../prometheus';
import { Result } from 'prometheus-remote-write';

const asLogger = new AutoscalerLogger({ logLevel: 'debug' });
const logger = asLogger.createLogger('debug');

const options = <PrometheusOptions>{
    logger,
    endpoint: 'http://localhost:9090',
};

const client = new PrometheusClient(options);
const driver = client.prometheusDriver();
const writer = client.prometheusWriter();
const ctx = { logger };
ctx.logger.debug = mock.fn();
ctx.logger.error = mock.fn();
writer.pushMetrics = mock.fn(
    () =>
        <Result>{
            status: 204,
            statusText: 'OK',
        },
);
driver.rangeQuery = mock.fn(
    () =>
        <Result>{
            result: [
                { metric: { labels: { instance: 'test', group: 'test' } }, values: [{ value: 0.1, time: new Date() }] },
            ],
        },
);
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
            const res = await client.fetchInstanceMetrics(ctx, group, driver);
            assert.notEqual(res.length, 0);
            assert.strictEqual(res[0].instanceId, 'test');
            assert.strictEqual(res[0].value, 0.1);
        });

        test('will handle errors when fetching', async () => {
            driver.rangeQuery.mock.mockImplementationOnce(() => {
                throw new Error('EXPECTED ERROR: DISREGARD');
            });
            const res = await client.fetchInstanceMetrics(ctx, group, driver);
            assert.strictEqual(res.length, 0);
        });

        test('will handle empty sets when fetching', async () => {
            driver.rangeQuery.mock.mockImplementationOnce(() => {
                return <Result>{ result: [] };
            });
            const res = await client.fetchInstanceMetrics(ctx, group, driver);
            assert.strictEqual(res.length, 0);
        });
    });
});
