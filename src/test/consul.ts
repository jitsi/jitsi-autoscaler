/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { beforeEach, afterEach, describe, mock } from 'node:test';

import ConsulClient, { ConsulOptions } from '../consul';
import { ConsulLockManager } from '../lock_manager';
import Consul from 'consul';
import { MockConsulClient } from './mock-consul-client';

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
    const consulClient = mockClient;
    let lockManager: ConsulLockManager;

    beforeEach(() => {
        lockManager = new ConsulLockManager({ consulClient, consulKeyPrefix: '_test/autoscaler/locks' });
    });

    afterEach(async () => {
        // end the session renewal loop
        await lockManager.shutdown();
        mock.restoreAll();
    });

    describe('will lock a group', () => {
        test('will lock a group', async () => {
            mockClient.kv.set.mock.mockImplementationOnce(() => true);
            const res = await lockManager.lockGroup(ctx, 'test');
            assert.ok(res.session, 'session is set');
            assert.strictEqual(res.key, '_test/autoscaler/locks/group/test');
            res.release(ctx);
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
                res2.release(ctx);
            }
            res.release(ctx);
            // sleep 1 second
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // now attempt to lock the group with second lock manager
            mockClient.kv.set.mock.mockImplementationOnce(() => true);
            const res3 = await secondLockManager.lockGroup(ctx, 'test');
            assert.ok(res3.session, 'session is set');
            assert.strictEqual(res3.key, '_test/autoscaler/locks/group/test');
            res3.release(ctx);
            await secondLockManager.shutdown();
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

describe('ConsulStore data operations (in-memory client)', () => {
    let mockConsul: MockConsulClient;
    let store: ConsulClient;

    beforeEach(() => {
        mockConsul = new MockConsulClient();
        store = new ConsulClient({
            client: mockConsul,
            idleTTL: 60,
            provisioningTTL: 60,
            shutdownStatusTTL: 60,
        });
    });

    afterEach(() => {
        mockConsul.clearAll();
    });

    // C1: checkValue must await fetchTTLValue and reflect presence/expiry
    describe('checkValue (C1)', () => {
        test('returns false for a missing key', async () => {
            assert.strictEqual(await store.checkValue(ctx, 'missing'), false);
        });

        test('returns true for an unexpired value', async () => {
            await store.setValue(ctx, 'k', 'v', 60);
            assert.strictEqual(await store.checkValue(ctx, 'k'), true);
        });

        test('returns false for an expired value', async () => {
            await store.setValue(ctx, 'k', 'v', -1);
            assert.strictEqual(await store.checkValue(ctx, 'k'), false);
        });
    });

    // C2: group definitions and per-group data must live in separate trees
    test('group listings exclude per-group data (C2)', async () => {
        await store.upsertInstanceGroup(ctx, group);
        await store.saveInstanceStatus(ctx, group.name, {
            instanceId: 'i-1',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group: group.name },
        });
        await store.setShutdownStatus(ctx, [{ instanceId: 'i-1', group: group.name }], 'shutdown', 60);

        const groups = await store.getAllInstanceGroups(ctx);
        assert.strictEqual(groups.length, 1, 'expect exactly one group, not phantom data groups');
        assert.strictEqual(groups[0].name, group.name);

        const names = await store.getAllInstanceGroupNames(ctx);
        assert.deepStrictEqual(names, [group.name]);
    });

    // C3: reconfigure write/read/delete paths must agree
    test('reconfigure date set/get/unset are consistent (C3)', async () => {
        const date = new Date().toISOString();
        await store.setReconfigureDate(ctx, [{ instanceId: 'i-1', group: group.name }], date, 60);

        assert.strictEqual(await store.getReconfigureDate(ctx, group.name, 'i-1'), date);
        assert.deepStrictEqual(await store.getReconfigureDates(ctx, group.name, ['i-1']), [date]);

        await store.unsetReconfigureDate(ctx, 'i-1', group.name);
        assert.strictEqual(await store.getReconfigureDate(ctx, group.name, 'i-1'), '');
    });

    test('expired reconfigure date reads as empty (C3)', async () => {
        await store.writeTTLValue(ctx, `autoscaler/group-data/${group.name}/reconfigure/i-1`, 'old-date', -1);
        assert.strictEqual(await store.getReconfigureDate(ctx, group.name, 'i-1'), '');
    });

    // C4: expired TTL entries must be deleted by their full consul path
    test('fetchRecursiveTTLValues deletes expired entries by full key (C4)', async () => {
        const prefix = 'autoscaler/group-data/testgroup/shutdown';
        await store.writeTTLValue(ctx, `${prefix}/x`, 'shutdown', -1);
        assert.ok(mockConsul.keys().includes(`${prefix}/x`), 'precondition: key exists');

        const res = await store.fetchRecursiveTTLValues(ctx, prefix);
        assert.deepStrictEqual(res, {}, 'expect empty map after expired entries are dropped');
        assert.ok(!mockConsul.keys().includes(`${prefix}/x`), 'expect the full key to be deleted from consul');
    });

    // C5: instance states must expire like the Redis store
    test('fetchInstanceStates trims expired states (C5)', async () => {
        await store.saveInstanceStatus(ctx, group.name, {
            instanceId: 'i-fresh',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group: group.name },
        });
        await store.saveInstanceStatus(ctx, group.name, {
            instanceId: 'i-expired',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now() - 120 * 1000, // idleTTL 60s -> expired
            metadata: { group: group.name },
        });

        const states = await store.fetchInstanceStates(ctx, group.name);
        assert.strictEqual(states.length, 1, 'expect only the fresh state');
        assert.strictEqual(states[0].instanceId, 'i-fresh');
        assert.ok(
            !mockConsul.keys().includes(`autoscaler/group-data/${group.name}/states/i-expired`),
            'expect the expired state key to be deleted',
        );
    });

    // C6: empty group must not crash
    test('fetchInstanceStates returns [] for an unknown group (C6)', async () => {
        const states = await store.fetchInstanceStates(ctx, 'no-such-group');
        assert.deepStrictEqual(states, []);
    });

    // C4-CAS: clean-path deletes must be CAS-guarded so a concurrently-refreshed value is not clobbered
    test('deleteCas only deletes when the ModifyIndex still matches', async () => {
        await mockConsul.kv.set('some/key', 'v1');
        const stale = (await mockConsul.kv.get('some/key')).ModifyIndex;

        // a concurrent writer refreshes the value, bumping ModifyIndex
        await mockConsul.kv.set('some/key', 'v2');

        assert.strictEqual(await store.deleteCas('some/key', stale), false, 'stale CAS delete must fail');
        assert.ok(mockConsul.keys().includes('some/key'), 'refreshed value must survive a stale CAS delete');

        const current = (await mockConsul.kv.get('some/key')).ModifyIndex;
        assert.strictEqual(await store.deleteCas('some/key', current), true, 'matching CAS delete must succeed');
        assert.ok(!mockConsul.keys().includes('some/key'), 'value must be gone after a matching CAS delete');
    });

    // Phantom groups: leftover legacy per-group data under groupsPrefix must not be listed as groups
    test('group listings ignore legacy nested keys under groupsPrefix', async () => {
        await store.upsertInstanceGroup(ctx, group);
        // legacy layout wrote per-group data under the definitions prefix
        await mockConsul.kv.set('autoscaler/groups/test/states/i-legacy', JSON.stringify({ foo: 'bar' }));

        assert.deepStrictEqual(await store.getAllInstanceGroupNames(ctx), ['test']);
        const groups = await store.getAllInstanceGroups(ctx);
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].name, 'test');
    });

    // C7: an expired reservation must be cleaned up on read
    test('getReservation deletes an expired reservation (C7)', async () => {
        const reservation = { id: 'res-1', groupName: group.name, expiresAt: Date.now() + 60 * 1000 };
        await store.saveReservation(ctx, reservation);
        assert.ok(await store.getReservation(ctx, 'res-1'), 'precondition: reservation readable');

        // overwrite with an already-expired TTL wrapper
        await store.writeTTLValue(ctx, `autoscaler/reservations/${group.name}/res-1`, JSON.stringify(reservation), -1);
        const res = await store.getReservation(ctx, 'res-1');
        assert.strictEqual(res, null, 'expect expired reservation to read as null');
        assert.ok(
            !mockConsul.keys().includes(`autoscaler/reservations/${group.name}/res-1`),
            'expect expired reservation key to be deleted',
        );
    });
});
