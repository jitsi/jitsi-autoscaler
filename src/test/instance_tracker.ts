/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import { InstanceTracker } from '../instance_tracker';

describe('InstanceTracker', () => {
    let context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const redisClient = {
        hgetall: mock.fn(),
        hset: mock.fn(),
        hdel: mock.fn(),
        del: mock.fn(),
        scan: mock.fn(),
    };

    const shutdownManager = {
        shutdown: mock.fn(),
    };

    const audit = {
        log: mock.fn(),
    };

    const groupName = 'group';
    const groupDetails = {
        name: groupName,
        type: 'JVB',
        region: 'default',
        environment: 'test',
        compartmentId: 'test',
        instanceConfigurationId: 'test',
        enableAutoScale: true,
        enableLaunch: false,
        gracePeriodTTLSec: 480,
        protectedTTLSec: 600,
        scalingOptions: {
            minDesired: 1,
            maxDesired: 1,
            desiredCount: 1,
            scaleUpQuantity: 1,
            scaleDownQuantity: 1,
            scaleUpThreshold: 0.8,
            scaleDownThreshold: 0.3,
            scalePeriod: 60,
            scaleUpPeriodsCount: 2,
            scaleDownPeriodsCount: 2,
        },
    };

    const instanceTracker = new InstanceTracker({
        redisClient,
        redisScanCount: 100,
        shutdownManager,
        audit,
        idleTTL: 300,
        metricTTL: 3600,
        provisioningTTL: 900,
        shutdownStatusTTL: 86400,
        groupRelatedDataTTL: 172800,
    });

    afterEach(() => {
        context = {
            logger: {
                info: mock.fn(),
                debug: mock.fn(),
                error: mock.fn(),
                warn: mock.fn(),
            },
        };
    });

    describe('trackerMetricsTests', () => {
        test('should return the correct summary for JVB values', async () => {
            const metricInventoryPerPeriod = [
                [{ value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
                [{ value: 0.4, instanceId: 'i-0a1b2c3d4e5f6g7h8' }],
            ];
            const periodCount = metricInventoryPerPeriod.length;

            const results = await instanceTracker.getSummaryMetricPerPeriod(
                context,
                groupDetails,
                metricInventoryPerPeriod,
                periodCount,
            );

            //summary should average the values
            assert.deepEqual(results, [0.5, 0.4]);
        });
    });
});
