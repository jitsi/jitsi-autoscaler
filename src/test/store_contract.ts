/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/**
 * Cross-provider contract test. Runs the same scenario suite against both RedisStore (backed by the
 * mock redis client) and ConsulStore (backed by the mock consul client), so the two InstanceStore /
 * ReservationStore implementations cannot silently diverge in behavior. This is the single highest-
 * leverage guard against the kind of drift the storage remediation fixed.
 */
import assert from 'node:assert';
import test, { describe, mock, beforeEach } from 'node:test';

import RedisStore from '../redis';
import ConsulStore from '../consul';
import { MockRedisClient } from './mock-redis-client';
import { MockConsulClient } from './mock-consul-client';

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

const TTLS = { idleTTL: 60, provisioningTTL: 60, shutdownStatusTTL: 60 };

const providers = [
    {
        name: 'RedisStore',
        make: () =>
            new RedisStore({
                redisClient: new MockRedisClient(),
                redisScanCount: 100,
                metricTTL: 60,
                groupRelatedDataTTL: 60,
                serviceLevelMetricsTTL: 60,
                ...TTLS,
            }),
    },
    {
        name: 'ConsulStore',
        make: () => new ConsulStore({ client: new MockConsulClient(), ...TTLS }),
    },
];

const group = { name: 'cg', type: 'test', region: 'r', environment: 'e', tags: {} };

function freshState(id) {
    return {
        instanceId: id,
        instanceType: 'test',
        status: { provisioning: false },
        timestamp: Date.now(),
        metadata: { group: group.name },
    };
}

function expiredState(id) {
    return {
        instanceId: id,
        instanceType: 'test',
        status: { provisioning: false },
        timestamp: Date.now() - 120 * 1000, // idleTTL 60s -> expired
        metadata: { group: group.name },
    };
}

for (const provider of providers) {
    describe(`store contract: ${provider.name}`, () => {
        let store;
        let ctx;

        beforeEach(() => {
            store = provider.make();
            ctx = initContext();
        });

        test('group CRUD and listing purity', async () => {
            await store.upsertInstanceGroup(ctx, group);
            assert.deepStrictEqual(await store.getInstanceGroup(ctx, group.name), group);
            assert.deepStrictEqual(await store.getAllInstanceGroupNames(ctx), [group.name]);
            assert.strictEqual((await store.getAllInstanceGroups(ctx)).length, 1);

            // adding per-group data must not create phantom groups in the listings
            await store.saveInstanceStatus(ctx, group.name, freshState('i-1'));
            await store.setShutdownStatus(ctx, [{ instanceId: 'i-1', group: group.name }], 'shutdown', 60);
            assert.deepStrictEqual(await store.getAllInstanceGroupNames(ctx), [group.name]);
            assert.strictEqual((await store.getAllInstanceGroups(ctx)).length, 1);

            await store.deleteInstanceGroup(ctx, group.name);
            assert.ok(!(await store.getInstanceGroup(ctx, group.name)), 'group should be gone');
            assert.deepStrictEqual(await store.getAllInstanceGroupNames(ctx), []);
        });

        // Reservations (TTL expiry+3600s) and the grace flag are group-scoped and would otherwise
        // resurrect on a recreated group; both stores must purge them on delete. (Per-instance
        // shutdown/protected flags are keyed globally by instance id with their own short TTL and are
        // intentionally not enumerated here.)
        test('deleteInstanceGroup purges reservations and the grace flag', async () => {
            await store.upsertInstanceGroup(ctx, group);
            await store.saveReservation(ctx, { id: 'res-1', groupName: group.name, expiresAt: Date.now() + 60 * 1000 });
            await store.setScaleDownGrace(ctx, group.name, 60);

            await store.deleteInstanceGroup(ctx, group.name);

            assert.strictEqual(await store.getReservation(ctx, 'res-1'), null, 'reservation should be gone');
            assert.deepStrictEqual(
                await store.listReservations(ctx, group.name),
                [],
                'reservation list should be empty',
            );
            assert.strictEqual(await store.isScaleDownGraceActive(ctx, group.name), false, 'grace flag should be gone');
        });

        test('save / fetch / expire instance states', async () => {
            await store.saveInstanceStatus(ctx, group.name, freshState('i-fresh'));
            await store.saveInstanceStatus(ctx, group.name, expiredState('i-expired'));

            const states = await store.fetchInstanceStates(ctx, group.name);
            assert.strictEqual(states.length, 1, 'only the fresh state should remain');
            assert.strictEqual(states[0].instanceId, 'i-fresh');
        });

        test('shutdown status and confirmation', async () => {
            const details = [{ instanceId: 'i-1', group: group.name }];
            await store.setShutdownStatus(ctx, details, 'shutdown', 60);
            assert.strictEqual(await store.getShutdownStatus(ctx, group.name, 'i-1'), true);
            assert.strictEqual(await store.getShutdownStatus(ctx, group.name, 'i-unknown'), false);
            assert.deepStrictEqual(await store.getShutdownStatuses(ctx, group.name, ['i-1', 'i-unknown']), [
                true,
                false,
            ]);

            const dateStr = new Date().toISOString();
            await store.setShutdownConfirmation(ctx, details, dateStr, 60);
            assert.strictEqual(await store.getShutdownConfirmation(ctx, group.name, 'i-1'), dateStr);
            assert.strictEqual(await store.getShutdownConfirmation(ctx, group.name, 'i-unknown'), false);
            assert.deepStrictEqual(await store.getShutdownConfirmations(ctx, group.name, ['i-1']), [dateStr]);
        });

        test('scale-down protection', async () => {
            await store.setScaleDownProtected(ctx, group.name, 'i-1', 60, 'isScaleDownProtected');
            assert.deepStrictEqual(await store.areScaleDownProtected(ctx, group.name, ['i-1', 'i-2']), [true, false]);
        });

        test('reconfigure set / get / unset', async () => {
            const dateStr = new Date().toISOString();
            await store.setReconfigureDate(ctx, [{ instanceId: 'i-1', group: group.name }], dateStr, 60);
            assert.strictEqual(await store.getReconfigureDate(ctx, group.name, 'i-1'), dateStr);
            assert.deepStrictEqual(await store.getReconfigureDates(ctx, group.name, ['i-1']), [dateStr]);

            await store.unsetReconfigureDate(ctx, 'i-1', group.name);
            // Redis returns null for a missing key, Consul returns ''; both are falsy.
            assert.ok(!(await store.getReconfigureDate(ctx, group.name, 'i-1')), 'reconfigure date should be cleared');
            const afterUnset = await store.getReconfigureDates(ctx, group.name, ['i-1']);
            assert.strictEqual(afterUnset.length, 1);
            assert.ok(!afterUnset[0], 'reconfigure dates entry should be cleared');
        });

        test('setValue / checkValue with expiry', async () => {
            assert.strictEqual(await store.checkValue(ctx, 'k'), false);
            await store.setValue(ctx, 'k', 'v', 60);
            assert.strictEqual(await store.checkValue(ctx, 'k'), true);

            await store.setValue(ctx, 'k-exp', 'v', -1);
            assert.strictEqual(await store.checkValue(ctx, 'k-exp'), false);
        });

        test('reservations save / list / delete / grace', async () => {
            const reservation = { id: 'res-1', groupName: group.name, expiresAt: Date.now() + 60 * 1000 };
            await store.saveReservation(ctx, reservation);
            assert.deepStrictEqual(await store.getReservation(ctx, 'res-1'), reservation);
            assert.strictEqual((await store.listReservations(ctx, group.name)).length, 1);

            assert.strictEqual(await store.isScaleDownGraceActive(ctx, group.name), false);
            await store.setScaleDownGrace(ctx, group.name, 60);
            assert.strictEqual(await store.isScaleDownGraceActive(ctx, group.name), true);

            await store.deleteReservation(ctx, 'res-1', group.name);
            assert.strictEqual(await store.getReservation(ctx, 'res-1'), null);
            assert.deepStrictEqual(await store.listReservations(ctx, group.name), []);
        });
    });
}
