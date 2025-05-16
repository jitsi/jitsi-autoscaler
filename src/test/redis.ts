/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import test, { describe, mock, afterEach } from 'node:test';
import RedisStore from '../redis';
import Redis from 'ioredis';
import { Context } from '../context';

function log(msg, obj) {
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

describe('RedisStore', () => {
    let _keys = [];
    let _hashes = {};
    let _values = {};

    let context = initContext();

    const mockPipeline = {
        get: mock.fn((key) => _keys.push(key)),
        set: mock.fn(),
        exec: mock.fn(() =>
            Promise.resolve(
                _keys.map((k, i) => {
                    return [i, _values[k]];
                }),
            ),
        ),
        hget: mock.fn((key) => _keys.push(key)),
    };

    const mockClient = <unknown>{
        expire: mock.fn(),
        zremrangebyscore: mock.fn(() => 0),
        zadd: mock.fn((_z, _score, _value) => {
            _keys.push(_value);
            _values[_value] = _score;
        }),
        hget: mock.fn((_h, key) => {
            return _hashes[key];
        }),
        hgetall: mock.fn(),
        hset: mock.fn((_h, key, value) => {
            _hashes[key] = value;
        }),
        hscan: mock.fn(() => [0, []]),
        hdel: mock.fn(),
        del: mock.fn(),
        scan: mock.fn(),
        zrange: mock.fn(),
        set: mock.fn((key, value) => {
            _values[key] = value;
            return 'OK';
        }),
        get: mock.fn((key) => {
            if (!_values[key]) {
                return null;
            }
            return _values[key];
        }),
        pipeline: mock.fn(() => mockPipeline),
    };

    const redisStore = new RedisStore({
        redisClient: <Redis>mockClient,
        redisScanCount: 100,
        idleTTL: 60,
        metricTTL: 60,
        provisioningTTL: 60,
        shutdownStatusTTL: 60,
        groupRelatedDataTTL: 60,
        serviceLevelMetricsTTL: 60,
    });

    afterEach(() => {
        _keys = [];
        _hashes = {};
        _values = {};
        context = initContext();
    });

    test('redisStore checks for at least one group, finds none', async () => {
        const res = await redisStore.existsAtLeastOneGroup(context);
        assert.equal(res, false, 'expect no groups');
    });

    test('redisStore checks for at least one group, finds one', async () => {
        mockClient.hscan.mock.mockImplementationOnce(() => [0, ['group']]);
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
        const setRes = await redisStore.setScaleDownProtected(context, 'test', 'instance-123a', 900);
        assert.equal(setRes, true, 'expect set to succeed');
        const res = await redisStore.areScaleDownProtected(context, 'test', ['instance-123a']);
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

        mockClient.zrange.mock.mockImplementationOnce(() => {
            return [JSON.stringify(metric)];
        });

        await redisStore.writeInstanceMetric(context, group, metric);
        const metrics = await redisStore.fetchInstanceMetrics(context, group);

        assert.equal(metrics.length, 1, 'expect one metric');
        assert.equal(metrics[0].instanceId, metric.instanceId, 'expect correct instance ID');
        assert.equal(metrics[0].value, metric.value, 'expect correct metric value');
    });

    test('redisStore can clean instance metrics', async () => {
        const group = 'test-group';

        mockClient.zremrangebyscore.mock.mockImplementationOnce(() => 5); // 5 items cleaned up

        const result = await redisStore.cleanInstanceMetrics(context, group);
        assert.equal(result, true, 'expect successful cleanup');
        assert.ok(mockClient.zremrangebyscore.mock.calls.length > 0, 'expect zremrangebyscore to be called');
    });
});
