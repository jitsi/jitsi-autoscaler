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
        assert.equal(result, 'PONG', 'expect PONG response');
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
});
