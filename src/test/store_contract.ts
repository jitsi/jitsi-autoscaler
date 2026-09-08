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
import { ReservationStatus } from '../reservation';
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

function makeRedisStore(client) {
    return new RedisStore({
        redisClient: client,
        redisScanCount: 100,
        metricTTL: 60,
        groupRelatedDataTTL: 60,
        serviceLevelMetricsTTL: 60,
        ...TTLS,
    });
}

// Each provider exposes the store plus a way to inspect whether a reservation carries a store-level TTL,
// since the two backends model TTLs differently (Redis key TTL vs. Consul TTLValue.expires wrapper).
const providers = [
    {
        name: 'RedisStore',
        make: () => {
            const client = new MockRedisClient();
            return {
                store: makeRedisStore(client),
                reservationHasTTL: async (_groupName, id) => (await client.ttl(`reservation:${id}`)) > 0,
            };
        },
    },
    {
        name: 'ConsulStore',
        make: () => {
            const client = new MockConsulClient();
            return {
                store: new ConsulStore({ client, ...TTLS }),
                reservationHasTTL: async (groupName, id) => {
                    const item = await client.kv.get(`autoscaler/reservations/${groupName}/${id}`);
                    return !!item && JSON.parse(item.Value).expires > 0;
                },
            };
        },
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
        let reservationHasTTL;
        let ctx;

        beforeEach(() => {
            ({ store, reservationHasTTL } = provider.make());
            ctx = initContext();
        });

        test('cloud instances written by the sanity loop are readable through the store', async () => {
            assert.deepStrictEqual(await store.fetchCloudInstances(ctx, group.name), []);
            const instances = [
                { instanceId: 'i-1', cloudStatus: 'RUNNING', displayName: 'a' },
                { instanceId: 'i-2', cloudStatus: 'PROVISIONING', displayName: 'b' },
            ];
            await store.saveCloudInstances(ctx, group.name, instances);
            assert.deepStrictEqual(await store.fetchCloudInstances(ctx, group.name), instances);
            // group-scoped: a sibling group with a shared prefix sees nothing
            assert.deepStrictEqual(await store.fetchCloudInstances(ctx, `${group.name}-2`), []);
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

        // Reservations and the grace flag are group-scoped and would otherwise resurrect on a recreated
        // group; both stores must purge them on delete. (Per-instance shutdown/protected flags are keyed
        // globally by instance id with their own short TTL and are intentionally not enumerated here.)
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

        // A "take and hold" reservation (group autoscaling off) is never re-saved after creation, so a
        // store TTL would silently evict it once expiresAt+retention passes -- no Expired status, no
        // scale-down grace. Only terminal reservations may carry a store TTL.
        test('non-terminal reservations carry no store TTL, even long past expiresAt', async () => {
            const pastDue = Date.now() - 48 * 3600 * 1000;
            for (const status of [ReservationStatus.Pending, ReservationStatus.Active, ReservationStatus.Fulfilled]) {
                const id = `res-${status}`;
                await store.saveReservation(ctx, { id, groupName: group.name, status, expiresAt: pastDue });
                assert.strictEqual(await reservationHasTTL(group.name, id), false, `${status} must not have a TTL`);
                assert.deepStrictEqual(
                    await store.getReservation(ctx, id),
                    { id, groupName: group.name, status, expiresAt: pastDue },
                    `${status} reservation must still be readable`,
                );
            }
            const listed = await store.listReservations(ctx, group.name);
            assert.strictEqual(listed.length, 3, 'all held reservations must still be listed');
        });

        test('terminal reservations get a retention TTL and stay readable within it', async () => {
            for (const status of [ReservationStatus.Expired, ReservationStatus.Cancelled]) {
                const id = `res-${status}`;
                const reservation = { id, groupName: group.name, status, expiresAt: Date.now() - 1000 };
                await store.saveReservation(ctx, reservation);
                assert.strictEqual(await reservationHasTTL(group.name, id), true, `${status} must have a TTL`);
                assert.deepStrictEqual(await store.getReservation(ctx, id), reservation);
            }
        });

        test('re-saving a reservation switches its TTL with its status', async () => {
            const id = 'res-flip';
            const base = { id, groupName: group.name, expiresAt: Date.now() + 60 * 1000 };
            await store.saveReservation(ctx, { ...base, status: ReservationStatus.Active });
            assert.strictEqual(await reservationHasTTL(group.name, id), false);

            await store.saveReservation(ctx, { ...base, status: ReservationStatus.Cancelled });
            assert.strictEqual(await reservationHasTTL(group.name, id), true, 'cancelling must arm the TTL');

            // an operator re-activating a reservation must clear the TTL again
            await store.saveReservation(ctx, { ...base, status: ReservationStatus.Active });
            assert.strictEqual(await reservationHasTTL(group.name, id), false, 're-activating must clear the TTL');
        });
    });
}

// ---------------------------------------------------------------------------------------------------
// Error-path parity: every write must REJECT when the backing store fails. A swallowed failure reports
// success to the API caller / job while nothing was persisted (e.g. an instance we believe is shutting
// down keeps counting as active). Both stores must fail closed the same way.
// ---------------------------------------------------------------------------------------------------

// Redis client whose reads succeed (empty) so the write pipelines are reached, but whose direct writes
// reject and whose pipeline exec() reports a per-command error.
function failingRedisClient() {
    const boom = async () => {
        throw new Error('EXPECTED ERROR: redis down');
    };
    const pipeline = () => {
        const p = {
            async exec() {
                return [[new Error('EXPECTED ERROR: redis command failed'), null]];
            },
        };
        for (const cmd of ['get', 'set', 'del', 'hget', 'hset', 'hdel', 'expire', 'sadd', 'srem', 'zadd']) {
            p[cmd] = () => p;
        }
        return p;
    };
    return {
        pipeline,
        smembers: async () => [],
        get: async () => null,
        set: boom,
        hset: boom,
        del: boom,
        sadd: boom,
        srem: boom,
        zadd: boom,
        expire: boom,
    };
}

// Consul client whose kv.set either rejects or returns false (Consul declined the write), and whose
// kv.del rejects.
function failingConsulClient(setRejects) {
    return {
        kv: {
            get: async () => undefined,
            set: async () => {
                if (setRejects) {
                    throw new Error('EXPECTED ERROR: consul down');
                }
                return false;
            },
            del: async () => {
                throw new Error('EXPECTED ERROR: consul down');
            },
        },
        status: { leader: async () => 'leader' },
    };
}

const failingProviders = [
    {
        name: 'RedisStore (pipeline command errors / commands reject)',
        make: () => makeRedisStore(failingRedisClient()),
    },
    {
        name: 'ConsulStore (kv.set rejects)',
        make: () => new ConsulStore({ client: failingConsulClient(true), ...TTLS }),
    },
    {
        name: 'ConsulStore (kv.set returns false)',
        make: () => new ConsulStore({ client: failingConsulClient(false), ...TTLS }),
    },
];

const details = [{ instanceId: 'i-1', group: group.name }];
const writeCases = [
    ['upsertInstanceGroup', (s, ctx) => s.upsertInstanceGroup(ctx, group)],
    ['saveInstanceStatus', (s, ctx) => s.saveInstanceStatus(ctx, group.name, freshState('i-1'))],
    ['saveCloudInstances', (s, ctx) => s.saveCloudInstances(ctx, group.name, [])],
    ['setShutdownStatus', (s, ctx) => s.setShutdownStatus(ctx, details, 'shutdown', 60)],
    ['setShutdownConfirmation', (s, ctx) => s.setShutdownConfirmation(ctx, details, 'now', 60)],
    ['setReconfigureDate', (s, ctx) => s.setReconfigureDate(ctx, details, 'now', 60)],
    ['setScaleDownProtected', (s, ctx) => s.setScaleDownProtected(ctx, group.name, 'i-1', 60, 'isScaleDownProtected')],
    ['setValue', (s, ctx) => s.setValue(ctx, 'k', 'v', 60)],
    ['saveReservation', (s, ctx) => s.saveReservation(ctx, { id: 'r', groupName: group.name, expiresAt: Date.now() })],
    ['setScaleDownGrace', (s, ctx) => s.setScaleDownGrace(ctx, group.name, 60)],
    ['deleteInstanceGroup', (s, ctx) => s.deleteInstanceGroup(ctx, group.name)],
    ['deleteReservation', (s, ctx) => s.deleteReservation(ctx, 'r', group.name)],
];

for (const provider of failingProviders) {
    describe(`store contract, failing backend: ${provider.name}`, () => {
        for (const [name, run] of writeCases) {
            test(`${name} rejects instead of reporting success`, async () => {
                const store = provider.make();
                await assert.rejects(() => run(store, initContext()), `${name} must reject when the store fails`);
            });
        }

        test('ping resolves false rather than throwing or returning a truthy non-boolean', async () => {
            const store = provider.make();
            // the failing consul client's status.leader succeeds, so only a broken leader() call is probed here
            if (store instanceof ConsulStore) {
                store['client'].status.leader = async () => {
                    throw new Error('EXPECTED ERROR: consul down');
                };
            } else {
                store['redisClient'].ping = (cb) => cb(new Error('EXPECTED ERROR: redis down'), undefined);
            }
            assert.strictEqual(await store.ping(initContext()), false);
        });
    });
}
