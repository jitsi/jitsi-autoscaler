/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { beforeEach, afterEach, describe, mock } from 'node:test';

import ConsulClient, { ConsulOptions } from '../consul';
import { ConsulLockManager } from '../lock_manager';
import Consul from 'consul';
import { MockConsulClient } from './mock-consul-client';
import { InstanceTracker } from '../instance_tracker';
import ShutdownManager from '../shutdown_manager';

// Writes an already-expired TTLValue straight into the mock KV. writeTTLValue rejects negative TTLs, so
// tests that need an expired entry craft the wrapper directly instead of writing with ttl -1.
function writeExpiredTTLValue(mockConsul: MockConsulClient, key: string, status: string) {
    return mockConsul.kv.set(key, JSON.stringify({ status, expires: Date.now() - 1000 }));
}

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
            mockClient.kv.set.mock.mockImplementationOnce(() => true);
            const res = await client.upsertInstanceGroup(ctx, group);
            assert.strictEqual(res, true);
        });

        test('upsert rejects when consul declines the write', async () => {
            mockClient.kv.set.mock.mockImplementationOnce(() => false);
            await assert.rejects(() => client.upsertInstanceGroup(ctx, group), /Failed to write to consul/);
        });

        test('upsert rejects when the consul write throws', async () => {
            mockClient.kv.set.mock.mockImplementationOnce(() => {
                throw new Error('EXPECTED ERROR: consul down');
            });
            await assert.rejects(() => client.upsertInstanceGroup(ctx, group), /EXPECTED ERROR/);
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
            await writeExpiredTTLValue(mockConsul, 'autoscaler/values/k', 'v');
            assert.strictEqual(await store.checkValue(ctx, 'k'), false);
        });
    });

    // A non-finite ttl used to serialize `expires: null`, which reads as never-expires: a group created
    // without protectedTTLSec would leave its instances permanently scale-down protected.
    describe('writeTTLValue rejects invalid TTLs', () => {
        test('setValue with an undefined ttl rejects and writes nothing', async () => {
            await assert.rejects(() => store.setValue(ctx, 'k', 'v', undefined), /Invalid TTL/);
            assert.strictEqual(await store.checkValue(ctx, 'k'), false, 'nothing must have been written');
            assert.deepStrictEqual(mockConsul.keys(), []);
        });

        test('NaN, negative and non-numeric ttls reject', async () => {
            await assert.rejects(() => store.setValue(ctx, 'k', 'v', NaN), /Invalid TTL/);
            await assert.rejects(() => store.setValue(ctx, 'k', 'v', -1), /Invalid TTL/);
            await assert.rejects(() => store.setValue(ctx, 'k', 'v', '60'), /Invalid TTL/);
            await assert.rejects(
                () => store.setScaleDownProtected(ctx, group.name, 'i-1', undefined, 'isScaleDownProtected'),
                /Invalid TTL/,
            );
            assert.deepStrictEqual(await store.areScaleDownProtected(ctx, group.name, ['i-1']), [false]);
        });

        test('a valid ttl still works', async () => {
            await store.setValue(ctx, 'k', 'v', 60);
            assert.strictEqual(await store.checkValue(ctx, 'k'), true);
            await store.setValue(ctx, 'k0', 'v', 0);
            assert.strictEqual(await store.checkValue(ctx, 'k0'), false, 'a zero ttl expires immediately');
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
        await writeExpiredTTLValue(mockConsul, `autoscaler/group-data/${group.name}/reconfigure/i-1`, 'old-date');
        assert.strictEqual(await store.getReconfigureDate(ctx, group.name, 'i-1'), '');
    });

    // C4: expired TTL entries must be deleted by their full consul path
    test('fetchRecursiveTTLValues deletes expired entries by full key (C4)', async () => {
        const prefix = 'autoscaler/group-data/testgroup/shutdown';
        await writeExpiredTTLValue(mockConsul, `${prefix}/x`, 'shutdown');
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
        await writeExpiredTTLValue(
            mockConsul,
            `autoscaler/reservations/${group.name}/res-1`,
            JSON.stringify(reservation),
        );
        const res = await store.getReservation(ctx, 'res-1');
        assert.strictEqual(res, null, 'expect expired reservation to read as null');
        assert.ok(
            !mockConsul.keys().includes(`autoscaler/reservations/${group.name}/res-1`),
            'expect expired reservation key to be deleted',
        );
    });

    // Review #7: the expired-reservation cleanup must be CAS-guarded like fetchRecursiveTTLValues, so a
    // reservation re-saved between our read and our delete is not clobbered.
    test('getReservation does not clobber a reservation rewritten between its read and the expired-delete', async () => {
        const key = `autoscaler/reservations/${group.name}/res-1`;
        const stale = { id: 'res-1', groupName: group.name, expiresAt: Date.now() - 1000 };
        const fresh = { id: 'res-1', groupName: group.name, expiresAt: Date.now() + 60 * 1000 };
        await writeExpiredTTLValue(mockConsul, key, JSON.stringify(stale));

        // simulate a concurrent writer that re-saves the reservation right after our recursive read
        const originalGet = mockConsul.kv.get;
        mockConsul.kv.get = async (arg) => {
            const res = await originalGet(arg);
            mockConsul.kv.get = originalGet;
            await mockConsul.kv.set(key, JSON.stringify({ status: JSON.stringify(fresh), expires: 0 }));
            return res;
        };

        assert.strictEqual(await store.getReservation(ctx, 'res-1'), null, 'the value we read was expired');
        assert.ok(mockConsul.keys().includes(key), 'the concurrently refreshed reservation must survive');
        assert.deepStrictEqual(await store.getReservation(ctx, 'res-1'), fresh, 'next read sees the fresh value');
    });

    // Prefix isolation: `.../reservations/g` must not also match `.../reservations/g-2/...`.
    test('listReservations does not leak reservations from a group with a longer, prefix-sharing name', async () => {
        const rG = { id: 'res-g', groupName: 'g', expiresAt: Date.now() + 60 * 1000 };
        const rG2 = { id: 'res-g2', groupName: 'g-2', expiresAt: Date.now() + 60 * 1000 };
        await store.saveReservation(ctx, rG);
        await store.saveReservation(ctx, rG2);

        assert.deepStrictEqual(await store.listReservations(ctx, 'g'), [rG]);
        assert.deepStrictEqual(await store.listReservations(ctx, 'g-2'), [rG2]);
    });

    // fetchRecursiveTTLValues normalizes the trailing slash so short keys are stripped correctly either way.
    test('fetchRecursiveTTLValues strips the prefix identically with and without a trailing slash', async () => {
        const prefix = 'autoscaler/group-data/testgroup/shutdown';
        await store.writeTTLValue(ctx, `${prefix}/i-1`, 'shutdown', 60);
        await store.writeTTLValue(ctx, `${prefix}-other/i-2`, 'shutdown', 60);

        const withoutSlash = await store.fetchRecursiveTTLValues(ctx, prefix);
        const withSlash = await store.fetchRecursiveTTLValues(ctx, `${prefix}/`);
        assert.deepStrictEqual(Object.keys(withoutSlash), ['i-1']);
        assert.deepStrictEqual(Object.keys(withSlash), ['i-1']);
    });

    // A never-expiring TTLValue (expires: 0) must survive the clean pass and read as present.
    test('TTLValues with expires=0 never expire', async () => {
        await store.writePersistentValue(ctx, 'autoscaler/group-data/testgroup/protected/i-1', 'isScaleDownProtected');
        assert.deepStrictEqual(await store.areScaleDownProtected(ctx, 'testgroup', ['i-1']), [true]);
        assert.ok(mockConsul.keys().includes('autoscaler/group-data/testgroup/protected/i-1'), 'not cleaned up');
    });

    // Consul write path must fail closed for the batched per-instance writes too.
    test('setShutdownStatus rejects when any write fails', async () => {
        const original = mockConsul.kv.set;
        let calls = 0;
        mockConsul.kv.set = async (...args) => {
            if (++calls === 2) {
                throw new Error('EXPECTED ERROR: consul down');
            }
            return original(...args);
        };
        await assert.rejects(() =>
            store.setShutdownStatus(
                ctx,
                [
                    { instanceId: 'i-1', group: group.name },
                    { instanceId: 'i-2', group: group.name },
                ],
                'shutdown',
                60,
            ),
        );
    });

    test('ping returns false (never the error) when consul is unreachable', async () => {
        mockConsul.status.leader = async () => {
            throw new Error('EXPECTED ERROR: consul down');
        };
        assert.strictEqual(await store.ping(ctx), false);
    });
});

// C8: existsAtLeastOneGroup must reflect group *definitions* only. Per-group data (states, shutdown
// flags, reservations) lives in separate trees after C2 and must never count as a group.
describe('ConsulStore existsAtLeastOneGroup (C8)', () => {
    let mockConsul: MockConsulClient;
    let store: ConsulClient;

    beforeEach(() => {
        mockConsul = new MockConsulClient();
        store = new ConsulClient({ client: mockConsul, idleTTL: 60, provisioningTTL: 60, shutdownStatusTTL: 60 });
    });

    afterEach(() => {
        mockConsul.clearAll();
    });

    test('returns false when no groups exist', async () => {
        assert.strictEqual(await store.existsAtLeastOneGroup(ctx), false);
    });

    test('returns false when only per-group data exists without a definition', async () => {
        await store.saveInstanceStatus(ctx, 'ghost', {
            instanceId: 'i-1',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group: 'ghost' },
        });
        await store.setShutdownStatus(
            ctx,
            [{ instanceId: 'i-1', instanceType: 'test', group: 'ghost' }],
            'shutdown',
            60,
        );
        await store.saveReservation(ctx, { id: 'r-1', groupName: 'ghost', expiresAt: Date.now() + 60000 });
        assert.strictEqual(await store.existsAtLeastOneGroup(ctx), false, 'per-group data must not count as a group');
    });

    test('returns true once a group definition is upserted', async () => {
        await store.upsertInstanceGroup(ctx, { name: 'real', type: 'test', region: 'r', environment: 'e', tags: {} });
        assert.strictEqual(await store.existsAtLeastOneGroup(ctx), true);
    });

    test('returns false again after the only group is deleted', async () => {
        await store.upsertInstanceGroup(ctx, { name: 'real', type: 'test', region: 'r', environment: 'e', tags: {} });
        await store.deleteInstanceGroup(ctx, 'real');
        assert.strictEqual(await store.existsAtLeastOneGroup(ctx), false);
    });
});

// Review #1 / #3 / #7 / #11 / #6 and the legacy-layout migration: ConsulStore hardening, all against the
// in-memory client so the key layout and the exact KV calls can be inspected.
describe('ConsulStore hardening (in-memory client)', () => {
    let mockConsul: MockConsulClient;
    let store: ConsulClient;
    let wctx;

    beforeEach(() => {
        mockConsul = new MockConsulClient();
        store = new ConsulClient({ client: mockConsul, idleTTL: 60, provisioningTTL: 60, shutdownStatusTTL: 60 });
        wctx = { logger: { info: mock.fn(), debug: mock.fn(), error: mock.fn(), warn: mock.fn() } };
    });

    afterEach(() => {
        mockConsul.clearAll();
    });

    function warnedKeys() {
        return wctx.logger.warn.mock.calls.map((c) => c.arguments[1]?.key);
    }

    async function seedGroup(name = 'test') {
        await store.upsertInstanceGroup(wctx, { ...group, name });
        await store.saveInstanceStatus(wctx, name, {
            instanceId: 'i-1',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group: name },
        });
        await store.setShutdownStatus(wctx, [{ instanceId: 'i-1', group: name }], 'shutdown', 60);
        await store.saveReservation(wctx, { id: 'res-1', groupName: name, expiresAt: Date.now() + 60000 });
        await store.setScaleDownGrace(wctx, name, 60);
    }

    describe('deleteInstanceGroup (review #1)', () => {
        test('purges the definition, group data, reservations, grace flag and nothing else', async () => {
            await seedGroup('test');
            await seedGroup('test-2');

            await store.deleteInstanceGroup(wctx, 'test');

            const remaining = mockConsul.keys();
            assert.ok(!remaining.some((k) => k.includes('/test/') || k.endsWith('/test') || k.endsWith(':test')));
            assert.ok(remaining.includes('autoscaler/groups/test-2'), 'prefix-sharing sibling definition kept');
            assert.ok(remaining.includes('autoscaler/group-data/test-2/states/i-1'), 'sibling data kept');
            assert.ok(remaining.includes('autoscaler/reservations/test-2/res-1'), 'sibling reservations kept');
            assert.ok(remaining.includes('autoscaler/values/reservation-scaledown-grace:test-2'), 'sibling grace kept');
            assert.strictEqual(await store.getInstanceGroup(wctx, 'test'), undefined);
        });

        test('keeps the definition and rejects when a data delete fails, so the caller can retry', async () => {
            await seedGroup('test');
            const originalDel = mockConsul.kv.del;
            mockConsul.kv.del = async (arg) => {
                if (typeof arg !== 'string' && arg.key === 'autoscaler/group-data/test/') {
                    throw new Error('EXPECTED ERROR: consul down');
                }
                return originalDel(arg);
            };

            await assert.rejects(() => store.deleteInstanceGroup(wctx, 'test'), /group data not deleted/);
            assert.ok(
                mockConsul.keys().includes('autoscaler/groups/test'),
                'definition must survive a failed data delete',
            );
            assert.deepStrictEqual(await store.getInstanceGroup(wctx, 'test'), { ...group, name: 'test' });
            assert.strictEqual(wctx.logger.error.mock.calls.length, 1, 'each failed subtree is logged');

            // the retry (with consul healthy again) completes the delete
            mockConsul.kv.del = originalDel;
            await store.deleteInstanceGroup(wctx, 'test');
            assert.deepStrictEqual(mockConsul.keys(), []);
        });

        test('purges legacy nested keys under groupsPrefix from the pre-C2 layout', async () => {
            await seedGroup('test');
            await mockConsul.kv.set(
                'autoscaler/groups/test/states/i-legacy',
                JSON.stringify({ instanceId: 'i-legacy' }),
            );
            await mockConsul.kv.set(
                'autoscaler/groups/test/shutdown/i-legacy',
                JSON.stringify({ status: 'x', expires: 0 }),
            );
            await mockConsul.kv.set('autoscaler/groups/test-2', JSON.stringify({ ...group, name: 'test-2' }));

            await store.deleteInstanceGroup(wctx, 'test');

            assert.deepStrictEqual(mockConsul.keys(), ['autoscaler/groups/test-2']);
        });
    });

    describe('group listings ignore empty-valued keys (review #3)', () => {
        test('an empty-valued key under groupsPrefix is not a group', async () => {
            await mockConsul.kv.set('autoscaler/groups/dir-placeholder', '');
            await mockConsul.kv.set('autoscaler/groups/', '');
            assert.strictEqual(await store.existsAtLeastOneGroup(wctx), false);
            assert.deepStrictEqual(await store.getAllInstanceGroupNames(wctx), []);
            assert.deepStrictEqual(await store.getAllInstanceGroups(wctx), []);

            await store.upsertInstanceGroup(wctx, group);
            assert.deepStrictEqual(await store.getAllInstanceGroupNames(wctx), ['test']);
            assert.deepStrictEqual(
                (await store.getAllInstanceGroups(wctx)).map((g) => g.name),
                ['test'],
            );
            assert.strictEqual(await store.existsAtLeastOneGroup(wctx), true);
        });
    });

    describe('malformed values are skipped, not fatal (review #11)', () => {
        test('fetchInstanceStates skips a directory-style key and garbage JSON under states/', async () => {
            await store.saveInstanceStatus(wctx, 'g', {
                instanceId: 'i-ok',
                instanceType: 'test',
                status: { provisioning: false },
                timestamp: Date.now(),
                metadata: { group: 'g' },
            });
            await mockConsul.kv.set('autoscaler/group-data/g/states/', null);
            await mockConsul.kv.set('autoscaler/group-data/g/states/i-bad', '{not json');

            const states = await store.fetchInstanceStates(wctx, 'g');
            assert.deepStrictEqual(
                states.map((s) => s.instanceId),
                ['i-ok'],
            );
            assert.deepStrictEqual(warnedKeys().sort(), [
                'autoscaler/group-data/g/states/',
                'autoscaler/group-data/g/states/i-bad',
            ]);
        });

        test('shutdown statuses skip a null-valued key and garbage JSON under shutdown/', async () => {
            await store.setShutdownStatus(wctx, [{ instanceId: 'i-ok', group: 'g' }], 'shutdown', 60);
            await mockConsul.kv.set('autoscaler/group-data/g/shutdown/', null);
            await mockConsul.kv.set('autoscaler/group-data/g/shutdown/i-bad', 'garbage');

            assert.deepStrictEqual(await store.getShutdownStatuses(wctx, 'g', ['i-ok', 'i-bad']), [true, false]);
            assert.deepStrictEqual(warnedKeys().sort(), [
                'autoscaler/group-data/g/shutdown/',
                'autoscaler/group-data/g/shutdown/i-bad',
            ]);
            // the bad keys are left alone (only expired TTL values are reaped)
            assert.ok(mockConsul.keys().includes('autoscaler/group-data/g/shutdown/i-bad'));
        });

        test('reservation reads skip bad siblings', async () => {
            const good = { id: 'res-ok', groupName: 'g', expiresAt: Date.now() + 60000 };
            await store.saveReservation(wctx, good);
            await mockConsul.kv.set('autoscaler/reservations/g/', null);
            await mockConsul.kv.set('autoscaler/reservations/g/res-bad', '<<<');
            // valid TTL wrapper whose inner reservation is garbage
            await mockConsul.kv.set(
                'autoscaler/reservations/g/res-inner',
                JSON.stringify({ status: '{oops', expires: 0 }),
            );

            assert.deepStrictEqual(await store.listReservations(wctx, 'g'), [good]);
            assert.deepStrictEqual(await store.getReservation(wctx, 'res-ok'), good);
            assert.strictEqual(await store.getReservation(wctx, 'res-bad'), null);
            assert.strictEqual(await store.getReservation(wctx, 'res-inner'), null);
            assert.ok(warnedKeys().includes('autoscaler/reservations/g/res-bad'));
            assert.ok(warnedKeys().includes('autoscaler/reservations/g/res-inner'));
            assert.ok(warnedKeys().includes('autoscaler/reservations/g/'));
        });

        test('getAllInstanceGroups skips a garbage definition and keeps its siblings', async () => {
            await store.upsertInstanceGroup(wctx, group);
            await mockConsul.kv.set('autoscaler/groups/broken', '{"name": ');

            const groups = await store.getAllInstanceGroups(wctx);
            assert.deepStrictEqual(
                groups.map((g) => g.name),
                ['test'],
            );
            assert.deepStrictEqual(warnedKeys(), ['autoscaler/groups/broken']);
            // the name listing is layout-only and still reports the key so operators can find and fix it
            assert.deepStrictEqual((await store.getAllInstanceGroupNames(wctx)).sort(), ['broken', 'test']);
        });
    });

    describe('shutdown subtree is read once per trimCurrent (review #6)', () => {
        function countingTracker() {
            const counts = { shutdown: 0, confirmation: 0, states: 0 };
            const originalGet = mockConsul.kv.get;
            mockConsul.kv.get = async (arg) => {
                if (typeof arg !== 'string' && arg.recurse) {
                    if (arg.key.includes('/shutdown')) counts.shutdown++;
                    if (arg.key.includes('/confirmation')) counts.confirmation++;
                    if (arg.key.includes('/states')) counts.states++;
                }
                return originalGet(arg);
            };
            const audit = {
                saveShutdownEvents: mock.fn(),
                saveShutdownConfirmationEvents: mock.fn(),
                saveLatestStatus: mock.fn(),
            };
            const shutdownManager = new ShutdownManager({ instanceStore: store, shutdownTTL: 60, audit });
            const tracker = new InstanceTracker({ instanceStore: store, metricsStore: store, shutdownManager, audit });
            return { tracker, counts };
        }

        function state(id, extra = {}) {
            return {
                instanceId: id,
                instanceType: 'test',
                status: { provisioning: false },
                timestamp: Date.now(),
                metadata: { group: 'g' },
                ...extra,
            };
        }

        test('trimCurrent issues exactly one recursive GET of the shutdown subtree', async () => {
            await store.saveInstanceStatus(wctx, 'g', state('i-running'));
            await store.saveInstanceStatus(wctx, 'g', state('i-shutting-down'));
            await store.saveInstanceStatus(
                wctx,
                'g',
                state('i-expired-shutdown', { timestamp: Date.now() - 90 * 1000 }),
            );
            await store.saveInstanceStatus(wctx, 'g', state('i-expired-idle', { timestamp: Date.now() - 90 * 1000 }));
            await store.setShutdownStatus(
                wctx,
                [
                    { instanceId: 'i-shutting-down', group: 'g' },
                    { instanceId: 'i-expired-shutdown', group: 'g' },
                ],
                'shutdown',
                60,
            );
            const { tracker, counts } = countingTracker();

            const states = await tracker.trimCurrent(wctx, 'g');

            assert.deepStrictEqual(
                states.map((s) => s.instanceId),
                ['i-running'],
                'shutting-down instances are filtered out',
            );
            assert.strictEqual(counts.shutdown, 1, 'shutdown subtree must be read once, not twice');
            assert.strictEqual(counts.states, 1);
            assert.strictEqual(counts.confirmation, 1);
            // expiry policy unchanged: the shutting-down state got shutdownStatusTTL (60s < 90s -> expired too),
            // the idle one idleTTL; both expired keys are trimmed from the KV
            assert.ok(!mockConsul.keys().includes('autoscaler/group-data/g/states/i-expired-idle'));
            assert.ok(!mockConsul.keys().includes('autoscaler/group-data/g/states/i-expired-shutdown'));
            assert.ok(mockConsul.keys().includes('autoscaler/group-data/g/states/i-shutting-down'));
        });

        test('trimCurrent on an empty group still reaps expired shutdown keys with a single read', async () => {
            await writeExpiredTTLValue(mockConsul, 'autoscaler/group-data/g/shutdown/i-gone', 'shutdown');
            const { tracker, counts } = countingTracker();

            assert.deepStrictEqual(await tracker.trimCurrent(wctx, 'g'), []);
            assert.strictEqual(counts.shutdown, 1);
            assert.ok(!mockConsul.keys().includes('autoscaler/group-data/g/shutdown/i-gone'), 'expired key reaped');
        });

        test('trimCurrent(filterShutdown=false) reads the shutdown subtree at most once', async () => {
            await store.saveInstanceStatus(wctx, 'g', state('i-running'));
            const { tracker, counts } = countingTracker();

            const states = await tracker.trimCurrent(wctx, 'g', false);
            assert.deepStrictEqual(
                states.map((s) => s.instanceId),
                ['i-running'],
            );
            assert.strictEqual(counts.shutdown, 1);
            assert.strictEqual(counts.confirmation, 0);
        });
    });

    describe('migrateLegacyGroupData', () => {
        test('moves nested legacy keys under groupsPrefix to groupDataPrefix and removes them', async () => {
            await store.upsertInstanceGroup(wctx, group);
            const legacyState = JSON.stringify({ instanceId: 'i-1', metadata: { group: 'test' } });
            const legacyShutdown = JSON.stringify({ status: 'shutdown', expires: Date.now() + 60000 });
            const legacyProtected = JSON.stringify({ status: 'isScaleDownProtected', expires: 0 });
            await mockConsul.kv.set('autoscaler/groups/test/states/i-1', legacyState);
            await mockConsul.kv.set('autoscaler/groups/test/shutdown/i-1', legacyShutdown);
            await mockConsul.kv.set('autoscaler/groups/test/protected/i-1', legacyProtected);

            const summary = await store.migrateLegacyGroupData(wctx);

            assert.deepStrictEqual(summary, { moved: 3, skipped: 0, deleted: 3 });
            assert.deepStrictEqual(mockConsul.keys().sort(), [
                'autoscaler/group-data/test/protected/i-1',
                'autoscaler/group-data/test/shutdown/i-1',
                'autoscaler/group-data/test/states/i-1',
                'autoscaler/groups/test',
            ]);
            assert.strictEqual((await mockConsul.kv.get('autoscaler/group-data/test/states/i-1')).Value, legacyState);
            assert.strictEqual(
                (await mockConsul.kv.get('autoscaler/group-data/test/shutdown/i-1')).Value,
                legacyShutdown,
            );
            assert.strictEqual(
                (await mockConsul.kv.get('autoscaler/group-data/test/protected/i-1')).Value,
                legacyProtected,
            );
            // the moved data is readable through the normal store paths
            assert.deepStrictEqual(await store.getShutdownStatuses(wctx, 'test', ['i-1']), [true]);
            assert.deepStrictEqual(await store.areScaleDownProtected(wctx, 'test', ['i-1']), [true]);
            assert.strictEqual(wctx.logger.info.mock.calls.length, 1, 'summary logged at info');
            assert.deepStrictEqual(wctx.logger.info.mock.calls[0].arguments[1].moved, 3);
        });

        test('does not overwrite an existing target but still removes the legacy key', async () => {
            const current = JSON.stringify({ instanceId: 'i-1', timestamp: 2 });
            await mockConsul.kv.set('autoscaler/group-data/test/states/i-1', current);
            await mockConsul.kv.set(
                'autoscaler/groups/test/states/i-1',
                JSON.stringify({ instanceId: 'i-1', timestamp: 1 }),
            );
            await mockConsul.kv.set('autoscaler/groups/test/states/i-2', JSON.stringify({ instanceId: 'i-2' }));

            const summary = await store.migrateLegacyGroupData(wctx);

            assert.deepStrictEqual(summary, { moved: 1, skipped: 1, deleted: 2 });
            assert.strictEqual((await mockConsul.kv.get('autoscaler/group-data/test/states/i-1')).Value, current);
            assert.ok(mockConsul.keys().includes('autoscaler/group-data/test/states/i-2'));
            assert.ok(!mockConsul.keys().some((k) => k.startsWith('autoscaler/groups/test/')), 'legacy keys removed');
        });

        test('is a no-op on a clean tree and idempotent', async () => {
            await store.upsertInstanceGroup(wctx, group);
            await store.saveInstanceStatus(wctx, 'test', {
                instanceId: 'i-1',
                instanceType: 'test',
                status: { provisioning: false },
                timestamp: Date.now(),
                metadata: { group: 'test' },
            });
            const before = mockConsul.keys().sort();

            assert.deepStrictEqual(await store.migrateLegacyGroupData(wctx), { moved: 0, skipped: 0, deleted: 0 });
            assert.deepStrictEqual(mockConsul.keys().sort(), before);

            await mockConsul.kv.set('autoscaler/groups/test/states/i-2', JSON.stringify({ instanceId: 'i-2' }));
            assert.deepStrictEqual(await store.migrateLegacyGroupData(wctx), { moved: 1, skipped: 0, deleted: 1 });
            assert.deepStrictEqual(await store.migrateLegacyGroupData(wctx), { moved: 0, skipped: 0, deleted: 0 });
        });
    });
});
