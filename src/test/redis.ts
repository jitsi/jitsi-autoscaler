/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import test, { describe, mock, beforeEach, afterEach } from 'node:test';
import RedisStore from '../redis';
import Redis from 'ioredis';
import { Context } from '../context';
import { MockRedisClient } from './mock-redis-client';

function log(msg: string, obj: unknown): void {
    console.log(msg, JSON.stringify(obj));
}

function initContext(): Context {
    return {
        logger: {
            info: mock.fn(log),
            debug: mock.fn(log),
            error: mock.fn(log),
            warn: mock.fn(log),
        },
    };
}

describe('RedisStore with Mock Redis Client', () => {
    let mockRedisClient: MockRedisClient;
    let redisStore: RedisStore;
    let context: Context;

    beforeEach(() => {
        mockRedisClient = new MockRedisClient();
        redisStore = new RedisStore({
            redisClient: mockRedisClient as unknown as Redis,
            redisScanCount: 100,
            idleTTL: 60,
            metricTTL: 60,
            provisioningTTL: 60,
            shutdownStatusTTL: 60,
            groupRelatedDataTTL: 60,
            serviceLevelMetricsTTL: 60,
        });
        context = initContext();
    });

    afterEach(() => {
        mockRedisClient.clearAll();
        context = initContext();
    });

    test('untracked count round-trips through the metrics store and defaults to 0', async () => {
        assert.strictEqual(await redisStore.fetchMetricUnTrackedCount(context, 'g'), 0);
        await redisStore.saveMetricUnTrackedCount(context, 'g', 4);
        assert.strictEqual(await redisStore.fetchMetricUnTrackedCount(context, 'g'), 4);
        assert.strictEqual(await redisStore.fetchMetricUnTrackedCount(context, 'g-2'), 0);
    });

    test('redisStore checks for at least one group, finds none', async () => {
        const res = await redisStore.existsAtLeastOneGroup(context);
        assert.equal(res, false, 'expect no groups');
    });

    test('redisStore checks for at least one group, finds one', async () => {
        await mockRedisClient.hset('allgroups', 'testgroup', JSON.stringify({ name: 'testgroup' }));
        const res = await redisStore.existsAtLeastOneGroup(context);
        assert.equal(res, true, 'expect at least one group');
    });

    test('redisStore can store and retrieve a group', async () => {
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

        await redisStore.upsertInstanceGroup(context, group);
        const res = await redisStore.getInstanceGroup(context, group.name);
        assert.deepEqual(res, group, 'expect group to be stored and retrieved');
    });

    test('redisStore can set protected status and check for it', async () => {
        const instanceId = 'instance-123a';
        const group = 'test';

        await redisStore.setScaleDownProtected(context, group, instanceId, 900);
        const res = await redisStore.areScaleDownProtected(context, group, [instanceId]);
        assert.deepEqual(res, [true], 'expect instance to be protected');
    });

    test('redisStore does not find protected status for unknown instance', async () => {
        const res = await redisStore.areScaleDownProtected(context, 'test', ['instance-321b']);
        assert.deepEqual(res, [false], 'expect instance to be unprotected');
    });

    test('setValue and checkValue return as expected', async () => {
        const key = 'test-key';
        const value = 'test-value';
        const ttl = 60;

        const preCheckRes = await redisStore.checkValue(context, key);
        assert.equal(preCheckRes, false, 'expect pre-check value to fail');

        const res = await redisStore.setValue(context, key, value, ttl);
        assert.equal(res, true, 'expect set value to succeed');
        const checkRes = await redisStore.checkValue(context, key);
        assert.equal(checkRes, true, 'expect check value to succeed');
    });

    test('redisStore can write and fetch instance metrics', async () => {
        const group = 'test-group';
        const metric = {
            instanceId: 'test-instance',
            timestamp: Date.now(),
            value: 0.75,
        };

        await redisStore.writeInstanceMetric(context, group, metric);

        // Pre-populate the sorted set with our metric for testing
        // This simulates what zrange would return
        await mockRedisClient.zadd(`gmetric:instance:${group}`, metric.timestamp, JSON.stringify(metric));

        const metrics = await redisStore.fetchInstanceMetrics(context, group);

        assert.equal(metrics.length, 1, 'expect one metric');
        assert.equal(metrics[0].instanceId, metric.instanceId, 'expect correct instance ID');
        assert.equal(metrics[0].value, metric.value, 'expect correct metric value');
    });

    test('redisStore can clean instance metrics', async () => {
        const group = 'test-group';
        const validUntil = new Date(Date.now() - 60 * 1000).getTime(); // 1 minute ago

        // Add some test metrics with old timestamps that should be cleaned up
        const oldMetric = {
            instanceId: 'test-instance-old',
            timestamp: validUntil - 10000, // Older than validUntil
            value: 0.5,
        };

        const newMetric = {
            instanceId: 'test-instance-new',
            timestamp: Date.now(), // Current time
            value: 0.8,
        };

        await mockRedisClient.zadd(`gmetric:instance:${group}`, oldMetric.timestamp, JSON.stringify(oldMetric));
        await mockRedisClient.zadd(`gmetric:instance:${group}`, newMetric.timestamp, JSON.stringify(newMetric));

        const result = await redisStore.cleanInstanceMetrics(context, group);

        assert.equal(result, true, 'expect successful cleanup');

        // Verify that only the new metric remains
        const metrics = await redisStore.fetchInstanceMetrics(context, group);
        assert.equal(metrics.length, 1, 'expect only the new metric to remain');
        assert.equal(metrics[0].instanceId, newMetric.instanceId, 'expect only the new metric to remain');
    });

    test('redisStore can set and get shutdown status', async () => {
        const group = 'test-group';
        const instanceDetails = [
            { instanceId: 'test-instance-1', group },
            { instanceId: 'test-instance-2', group },
        ];

        await redisStore.setShutdownStatus(context, instanceDetails);

        const status1 = await redisStore.getShutdownStatus(context, group, 'test-instance-1');
        const status2 = await redisStore.getShutdownStatus(context, group, 'test-instance-2');
        const statusUnknown = await redisStore.getShutdownStatus(context, group, 'unknown-instance');

        assert.equal(status1, true, 'expect shutdown status to be true for instance 1');
        assert.equal(status2, true, 'expect shutdown status to be true for instance 2');
        assert.equal(statusUnknown, false, 'expect shutdown status to be false for unknown instance');
    });

    test('redisStore can ping Redis server', async () => {
        const result = await redisStore.ping(context);
        assert.strictEqual(result, true, 'expect a boolean true on PONG');
    });

    test('ping resolves false (not an error, not a truthy non-boolean) when redis errors', async () => {
        mockRedisClient.ping = (cb) => cb(new Error('EXPECTED ERROR: redis down'), undefined);
        assert.strictEqual(await redisStore.ping(context), false);
        mockRedisClient.ping = (cb) => cb(null, 'not-pong');
        assert.strictEqual(await redisStore.ping(context), false, 'anything but PONG is unhealthy');
    });

    // Sidecar-written keys must carry a TTL: a sidecar reporting for an unknown group would otherwise
    // create instances:status:<group> / gmetric:instance:<group> keys that live forever.
    test('saveInstanceStatus arms a TTL on the group states hash', async () => {
        const group = 'unknown-group';
        await redisStore.saveInstanceStatus(context, group, {
            instanceId: 'i-1',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group },
        });
        assert.notEqual(await mockRedisClient.hget(`instances:status:${group}`, 'i-1'), null, 'state is stored');
        const ttl = await mockRedisClient.ttl(`instances:status:${group}`);
        assert.ok(ttl > 0 && ttl <= 60, `expect a TTL of at most groupRelatedDataTTL (60s), got ${ttl}`);
    });

    test('writeInstanceMetric arms a TTL on the group metrics sorted set', async () => {
        const group = 'unknown-group';
        await redisStore.writeInstanceMetric(context, group, { instanceId: 'i-1', timestamp: Date.now(), value: 1 });
        assert.strictEqual((await mockRedisClient.zrange(`gmetric:instance:${group}`, 0, -1)).length, 1);
        const ttl = await mockRedisClient.ttl(`gmetric:instance:${group}`);
        assert.ok(ttl > 0 && ttl <= 60, `expect a TTL of at most groupRelatedDataTTL (60s), got ${ttl}`);
    });

    test('pipeline operations execute in sequence', async () => {
        const pipeline = mockRedisClient.pipeline();

        // Chain multiple operations
        pipeline.set('key1', 'value1');
        pipeline.set('key2', 'value2');
        pipeline.get('key1');

        const results = await pipeline.exec();

        assert.equal(results.length, 3, 'expect 3 results');
        assert.equal(results[0][1], 'OK', 'expect OK for first set operation');
        assert.equal(results[1][1], 'OK', 'expect OK for second set operation');
        assert.equal(results[2][1], 'value1', 'expect value1 for get operation');

        // Verify the values were actually set
        const key1Value = await mockRedisClient.get('key1');
        const key2Value = await mockRedisClient.get('key2');

        assert.equal(key1Value, 'value1', 'expect key1 to have value1');
        assert.equal(key2Value, 'value2', 'expect key2 to have value2');
    });

    test('TTL functionality expires keys', async () => {
        // Set a key with a very short TTL
        await mockRedisClient.set('shortTTL', 'will expire soon', 'EX', 1);

        // Verify it exists initially
        let value = await mockRedisClient.get('shortTTL');
        assert.equal(value, 'will expire soon', 'expect key to exist initially');

        // Wait for the key to expire (slightly more than 1 second)
        await new Promise((resolve) => setTimeout(resolve, 1100));

        // The next get should trigger the TTL check and return null
        value = await mockRedisClient.get('shortTTL');
        assert.equal(value, null, 'expect key to be expired');
    });

    test('hash operations work correctly', async () => {
        const hash = 'test-hash';

        // Test hset
        await mockRedisClient.hset(hash, 'field1', 'value1');
        await mockRedisClient.hset(hash, 'field2', 'value2');

        // Test hget
        const value1 = await mockRedisClient.hget(hash, 'field1');
        assert.equal(value1, 'value1', 'expect field1 to have value1');

        // Test hkeys
        const keys = await mockRedisClient.hkeys(hash);
        assert.deepEqual(keys.sort(), ['field1', 'field2'].sort(), 'expect both fields to be in keys');

        // Test hdel
        await mockRedisClient.hdel(hash, 'field1');
        const value1AfterDelete = await mockRedisClient.hget(hash, 'field1');
        assert.equal(value1AfterDelete, null, 'expect field1 to be deleted');

        // Test hscan
        const scanResult = await mockRedisClient.hscan(hash, '0');
        assert.equal(scanResult[0], '0', 'expect scan cursor to be 0');
        assert.deepEqual(scanResult[1], ['field2', 'value2'], 'expect field2 and value2 to be in scan result');
    });

    // R1: expired instance states must be HDEL'd from the correct key
    test('fetchInstanceStates deletes expired states from the group hash', async () => {
        const group = 'testgroup';
        const key = `instances:status:${group}`;
        const freshState = {
            instanceId: 'i-fresh',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group },
        };
        const expiredState = {
            instanceId: 'i-expired',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now() - 120 * 1000, // idleTTL is 60s, so 120s old is expired
            metadata: { group },
        };
        await mockRedisClient.hset(key, freshState.instanceId, JSON.stringify(freshState));
        await mockRedisClient.hset(key, expiredState.instanceId, JSON.stringify(expiredState));

        const states = await redisStore.fetchInstanceStates(context, group);

        assert.equal(states.length, 1, 'expect only the fresh state to be returned');
        assert.equal(states[0].instanceId, 'i-fresh', 'expect the fresh state to be returned');
        assert.equal(
            await mockRedisClient.hget(key, 'i-expired'),
            null,
            'expect the expired state to be HDELed from instances:status:<group>',
        );
        assert.notEqual(
            await mockRedisClient.hget(key, 'i-fresh'),
            null,
            'expect the fresh state to remain in the hash',
        );
    });

    // R3: per-command pipeline errors must throw rather than read as "flag not set"
    test('getShutdownStatuses throws when a pipeline command errors', async () => {
        const fakeClient = {
            pipeline() {
                return {
                    get() {
                        return this;
                    },
                    async exec() {
                        return [[new Error('x'), null]];
                    },
                };
            },
        };
        const store = new RedisStore({
            redisClient: fakeClient as unknown as Redis,
            redisScanCount: 100,
            idleTTL: 60,
            metricTTL: 60,
            provisioningTTL: 60,
            shutdownStatusTTL: 60,
            groupRelatedDataTTL: 60,
            serviceLevelMetricsTTL: 60,
        });
        await assert.rejects(
            () => store.getShutdownStatuses(context, 'group', ['i-1']),
            'expect getShutdownStatuses to throw on a pipeline command error',
        );
    });

    function storeWithFakeClient(fakeClient) {
        return new RedisStore({
            redisClient: fakeClient as unknown as Redis,
            redisScanCount: 100,
            idleTTL: 60,
            metricTTL: 60,
            provisioningTTL: 60,
            shutdownStatusTTL: 60,
            groupRelatedDataTTL: 60,
            serviceLevelMetricsTTL: 60,
        });
    }

    // listReservations must fail closed: a per-command error must not be read as "reservation expired"
    // and cause the id to be SREM'd from the group set (silently dropping a live reservation).
    test('listReservations throws on a pipeline command error and does not prune the group set', async () => {
        const srem = mock.fn(async () => 1);
        const store = storeWithFakeClient({
            smembers: async () => ['res-1'],
            srem,
            pipeline() {
                return {
                    get() {
                        return this;
                    },
                    async exec() {
                        return [[new Error('EXPECTED ERROR: command failed'), null]];
                    },
                };
            },
        });
        await assert.rejects(() => store.listReservations(context, 'group'));
        assert.strictEqual(srem.mock.callCount(), 0, 'a failed read must never prune reservation ids');
    });

    test('listReservations throws when pipeline.exec() returns null', async () => {
        const store = storeWithFakeClient({
            smembers: async () => ['res-1'],
            srem: async () => 1,
            pipeline() {
                return {
                    get() {
                        return this;
                    },
                    async exec() {
                        return null;
                    },
                };
            },
        });
        await assert.rejects(() => store.listReservations(context, 'group'));
    });

    test('listReservations prunes only ids whose key is genuinely gone (nil reply)', async () => {
        const live = { id: 'res-live', groupName: 'group', expiresAt: Date.now() + 60000 };
        await redisStore.saveReservation(context, live);
        // an id left in the set whose key has been deleted (TTL lapsed)
        await mockRedisClient.sadd('reservations:group:group', 'res-gone');

        const listed = await redisStore.listReservations(context, 'group');
        assert.deepStrictEqual(listed, [live]);
        assert.deepStrictEqual(await mockRedisClient.smembers('reservations:group:group'), ['res-live']);
    });

    // The per-group reservation id set must not expire: a held ("take and hold") reservation on a group with
    // autoscaling off is never re-saved, so an expiring set would make listReservations return [] and
    // deleteInstanceGroup unable to find (and delete) the reservation keys, while getReservation still finds them.
    test('saveReservation leaves the reservation group id set without a TTL', async () => {
        const group = 'held-group';
        await redisStore.saveReservation(context, {
            id: 'res-held',
            groupName: group,
            status: 'active',
            expiresAt: Date.now() + 60 * 1000,
        });

        assert.deepStrictEqual(await mockRedisClient.smembers('reservations:group:' + group), ['res-held']);
        assert.strictEqual(
            await mockRedisClient.ttl('reservations:group:' + group),
            -1,
            'expect the reservation group set to have no TTL',
        );
        assert.strictEqual(await mockRedisClient.ttl('reservation:res-held'), -1, 'non-terminal key has no TTL');
    });

    test('saveReservation clears a TTL previously armed on the reservation group id set', async () => {
        const group = 'deployed-group';
        // simulate a set written by a previous release which armed groupRelatedDataTTL on it
        await mockRedisClient.sadd('reservations:group:' + group, 'res-old');
        await mockRedisClient.expire('reservations:group:' + group, 60);
        assert.ok((await mockRedisClient.ttl('reservations:group:' + group)) > 0, 'precondition: set has a TTL');

        await redisStore.saveReservation(context, {
            id: 'res-new',
            groupName: group,
            status: 'active',
            expiresAt: Date.now() + 60 * 1000,
        });

        assert.strictEqual(
            await mockRedisClient.ttl('reservations:group:' + group),
            -1,
            'expect the previously armed TTL to be cleared',
        );
        assert.deepStrictEqual((await mockRedisClient.smembers('reservations:group:' + group)).sort(), [
            'res-new',
            'res-old',
        ]);
    });

    // R5: deleting a group must remove reservation keys too
    test('deleteInstanceGroup removes reservation keys', async () => {
        const group = 'test-group';
        const reservation = {
            id: 'res-1',
            groupName: group,
            expiresAt: Date.now() + 60 * 1000,
        };
        await redisStore.saveReservation(context, reservation);

        assert.notEqual(await redisStore.getReservation(context, 'res-1'), null, 'expect reservation to exist');

        await redisStore.deleteInstanceGroup(context, group);

        assert.equal(await redisStore.getReservation(context, 'res-1'), null, 'expect reservation key to be deleted');
        assert.equal(
            await mockRedisClient.get('reservations:group:' + group),
            null,
            'expect the reservation group set to be deleted',
        );
    });

    // R3 (breadth): every pipelined read must fail closed, both on a per-command error and on a null exec().
    // A flaky Redis must never read as "flag not set" (shutting-down instance counted as active, protected
    // instance scaled down, reconfigure date lost, instance state silently dropped).
    describe('pipelined reads fail closed (R3)', () => {
        function storeWithExecResult(execResult) {
            const fakeClient = {
                pipeline() {
                    return {
                        get() {
                            return this;
                        },
                        hget() {
                            return this;
                        },
                        async exec() {
                            return execResult;
                        },
                    };
                },
                // used by fetchInstanceStates before it reaches the pipelined hget
                async expire() {
                    return 1;
                },
                async hscan() {
                    return ['0', ['i-1']];
                },
            };
            return new RedisStore({
                redisClient: fakeClient as unknown as Redis,
                redisScanCount: 100,
                idleTTL: 60,
                metricTTL: 60,
                provisioningTTL: 60,
                shutdownStatusTTL: 60,
                groupRelatedDataTTL: 60,
                serviceLevelMetricsTTL: 60,
            });
        }

        const readers = [
            { name: 'getShutdownStatuses', call: (s) => s.getShutdownStatuses(context, 'group', ['i-1']) },
            { name: 'getShutdownConfirmations', call: (s) => s.getShutdownConfirmations(context, 'group', ['i-1']) },
            { name: 'areScaleDownProtected', call: (s) => s.areScaleDownProtected(context, 'group', ['i-1']) },
            { name: 'getReconfigureDates', call: (s) => s.getReconfigureDates(context, 'group', ['i-1']) },
            {
                name: 'fetchInstanceStates (via getInstanceStates)',
                call: (s) => s.fetchInstanceStates(context, 'group'),
            },
        ];

        for (const reader of readers) {
            test(`${reader.name} throws when a pipeline command errors`, async () => {
                await assert.rejects(
                    () => reader.call(storeWithExecResult([[new Error('x'), null]])),
                    /pipeline command errored/,
                    `${reader.name} must not read a per-command error as "not set"`,
                );
                assert.ok(context.logger.error.mock.callCount() >= 1, 'the failure must be logged');
            });

            test(`${reader.name} throws when exec() returns null`, async () => {
                await assert.rejects(
                    () => reader.call(storeWithExecResult(null)),
                    /returned null/,
                    `${reader.name} must not read a null exec() as an empty result`,
                );
            });
        }
    });

    // R6: a state without a timestamp must be treated as expired explicitly (logged + deleted), not by
    // accident of a NaN comparison.
    test('fetchInstanceStates treats a state without a timestamp as expired and warns', async () => {
        const group = 'testgroup';
        const key = `instances:status:${group}`;
        const freshState = {
            instanceId: 'i-fresh',
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: Date.now(),
            metadata: { group },
        };
        const noTimestampState = {
            instanceId: 'i-no-timestamp',
            instanceType: 'test',
            status: { provisioning: false },
            metadata: { group },
        };
        await mockRedisClient.hset(key, freshState.instanceId, JSON.stringify(freshState));
        await mockRedisClient.hset(key, noTimestampState.instanceId, JSON.stringify(noTimestampState));

        const states = await redisStore.fetchInstanceStates(context, group);

        assert.deepEqual(
            states.map((s) => s.instanceId),
            ['i-fresh'],
            'expect only the timestamped state to be returned',
        );
        assert.equal(
            await mockRedisClient.hget(key, 'i-no-timestamp'),
            null,
            'expect the timestamp-less state to be deleted from the hash',
        );
        const warnings = context.logger.warn.mock.calls.filter((c) => String(c.arguments[0]).includes('no timestamp'));
        assert.equal(warnings.length, 1, 'expect exactly one explicit warning about the missing timestamp');
        assert.equal(warnings[0].arguments[1].group, group, 'expect the warning to carry the group');
    });
});
