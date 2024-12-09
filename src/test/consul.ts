/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import ConsulClient, { ConsulOptions } from '../consul';

const asLogger = new AutoscalerLogger({ logLevel: 'debug' });
const logger = asLogger.createLogger('debug');

const ctx = { logger };
ctx.logger.debug = mock.fn();
ctx.logger.error = mock.fn();

const mockClient = {
    kv: {
        get: mock.fn(),
        set: mock.fn(),
        del: mock.fn(),
    },
};

const options = <ConsulOptions>{
    host: 'localhost',
    port: 8500,
    secure: false,
    groupsPrefix: '_test/autoscaler/groups/',
    client: mockClient,
};

const client = new ConsulClient(options);

const group = {
    name: 'test',
    type: 'test',
    region: 'test',
    environment: 'test',
    enableScheduler: true,
    tags: {
        test: 'test',
    },
};

describe('ConsulClient', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    describe('testListInstanceGroups', () => {
        test('will list all instance groups', async () => {
            const res = await client.fetchInstanceGroups(ctx);
            assert.strictEqual(res.length, 0);
        });

        test('will upsert a test group', async () => {
            const res = await client.upsertInstanceGroup(ctx, group);
            assert.strictEqual(res, true);
        });

        test('will find upserted group when listing all instance groups', async () => {
            mockClient.kv.get.mock.mockImplementationOnce(() => [
                {
                    Key: options.groupsPrefix + group.name,
                    Value: JSON.stringify(group),
                },
            ]);

            const res = await client.fetchInstanceGroups(ctx);
            assert.strictEqual(res.length, 1);
            assert.strictEqual(res[0], group.name);
            mockClient.kv.get.mock.mockImplementationOnce(
                () =>
                    <Consul.KVGetResponse>{
                        Key: options.groupsPrefix + group.name,
                        Value: JSON.stringify(group),
                    },
            );

            const res2 = await client.getInstanceGroup(ctx, group.name);
            assert.deepEqual(res2, group);
        });

        test('will delete upserted test group', async () => {
            const res = await client.deleteInstanceGroup(ctx, group.name);
            assert.strictEqual(res, true);
        });
    });
});
