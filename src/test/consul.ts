/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { beforeEach, afterEach, describe, mock } from 'node:test';

import ConsulClient, { ConsulOptions } from '../consul';
import { ConsulLockManager } from '../lock_manager';
import Consul from 'consul';

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
    status: {
        leader: mock.fn(),
    },
    session: {
        create: mock.fn(() => {
            return { ID: 'test' };
        }),
        destroy: mock.fn(),
    },
    agent: {
        service: {
            register: mock.fn(),
            deregister: mock.fn(),
        },
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

describe('ConsulLockManager', () => {
    //    const consulClient = new Consul({ host: 'localhost', port: 8500, secure: false });
    const consulClient = mockClient;
    let lockManager: ConsulLockManager;

    beforeEach(() => {
        lockManager = new ConsulLockManager({ consulClient, consulKeyPrefix: '_test/autoscaler/locks' });
    });

    afterEach(() => {
        // end the session renewal loop
        lockManager.shutdown();
        mock.restoreAll();
    });

    describe('will lock a group', () => {
        test('will lock a group', async () => {
            mockClient.kv.set.mock.mockImplementationOnce(() => true);
            const res = await lockManager.lockGroup(ctx, 'test');
            assert.ok(res.session, 'session is set');
            assert.strictEqual(res.key, '_test/autoscaler/locks/group/test');
            res.release();
        });

        test('will attempt a second lock on a group', async () => {
            mockClient.kv.set.mock.mockImplementationOnce(() => true);
            const res = await lockManager.lockGroup(ctx, 'test');
            assert.ok(res.session, 'session is set');
            assert.strictEqual(res.key, '_test/autoscaler/locks/group/test');

            const secondLockManager = new ConsulLockManager({
                consulClient,
                consulKeyPrefix: '_test/autoscaler/locks',
            });
            let res2;
            mockClient.kv.set.mock.mockImplementationOnce(() => {
                throw new Error('Failed to obtain lock for key _test/autoscaler/locks/group/test');
            });
            try {
                res2 = await secondLockManager.lockGroup(ctx, 'test');
                assert.fail('should not have obtained lock');
            } catch (err) {
                assert.strictEqual(err.message, 'Failed to obtain lock for key _test/autoscaler/locks/group/test');
            }

            if (res2) {
                res2.release();
            }
            res.release();
            // sleep 1 second
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // now attempt to lock the group with second lock manager
            mockClient.kv.set.mock.mockImplementationOnce(() => true);
            const res3 = await secondLockManager.lockGroup(ctx, 'test');
            assert.ok(res3.session, 'session is set');
            assert.strictEqual(res3.key, '_test/autoscaler/locks/group/test');
            res3.release();
            secondLockManager.shutdown();
        });
    });
});

describe('ConsulClient', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    describe('testListInstanceGroups', () => {
        test('will list all instance groups', async () => {
            const res = await client.getAllInstanceGroups(ctx);
            assert.strictEqual(res.length, 0);
        });

        test('will upsert a test group', async () => {
            const res = await client.upsertInstanceGroup(ctx, group);
            assert.strictEqual(res, true);
        });

        test('will find upserted group when listing all instance groups', async () => {
            mockClient.kv.get.mock.mockImplementationOnce(() => {
                return {
                    0: {
                        Key: options.groupsPrefix + group.name,
                        Value: JSON.stringify(group),
                    },
                };
            });

            const res = await client.getAllInstanceGroupNames(ctx);
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
            await client.deleteInstanceGroup(ctx, group.name);

            const res = await client.getInstanceGroup(ctx, group.name);
            assert.strictEqual(res, undefined);
        });
    });
});
