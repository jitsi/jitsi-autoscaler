/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import test, { describe, mock } from 'node:test';

import { partitionExpiredStates } from '../instance_state_expiry';

// partitionExpiredStates is the single expiry policy shared by RedisStore and ConsulStore (R1/R6/C5).
// These tests pin the policy itself so a change to it is caught independently of either store.
describe('partitionExpiredStates', () => {
    const ttls = { idleTTL: 60, provisioningTTL: 600, shutdownStatusTTL: 300 };
    const now = 1_000_000_000_000;

    function ctx() {
        return { logger: { info: mock.fn(), debug: mock.fn(), error: mock.fn(), warn: mock.fn() } };
    }

    function state(id, ageSeconds, extra = {}) {
        return {
            instanceId: id,
            instanceType: 'test',
            status: { provisioning: false },
            timestamp: now - ageSeconds * 1000,
            metadata: { group: 'g' },
            ...extra,
        };
    }

    test('idle states expire after idleTTL', () => {
        const states = [state('fresh', 59), state('boundary', 60), state('stale', 61)];
        const { valid, expired } = partitionExpiredStates(ctx(), 'g', states, [false, false, false], ttls, now);
        assert.deepEqual(
            valid.map((s) => s.instanceId),
            ['fresh', 'boundary'],
            'timestamp + ttl >= now is still valid (inclusive boundary)',
        );
        assert.deepEqual(
            expired.map((s) => s.instanceId),
            ['stale'],
        );
    });

    test('provisioning states use provisioningTTL', () => {
        const states = [state('prov', 120, { status: { provisioning: true } }), state('idle', 120)];
        const { valid, expired } = partitionExpiredStates(ctx(), 'g', states, [false, false], ttls, now);
        assert.deepEqual(
            valid.map((s) => s.instanceId),
            ['prov'],
            'a 120s-old provisioning state is within the 600s provisioning TTL',
        );
        assert.deepEqual(
            expired.map((s) => s.instanceId),
            ['idle'],
            'a 120s-old idle state is past the 60s idle TTL',
        );
    });

    test('shutting-down states use shutdownStatusTTL, whether flagged on the state or via the shutdown store', () => {
        const states = [
            state('flagged', 120, { isShuttingDown: true }),
            state('stored', 120),
            state('overdue', 301, { isShuttingDown: true }),
        ];
        const { valid, expired } = partitionExpiredStates(ctx(), 'g', states, [false, true, false], ttls, now);
        assert.deepEqual(
            valid.map((s) => s.instanceId),
            ['flagged', 'stored'],
        );
        assert.deepEqual(
            expired.map((s) => s.instanceId),
            ['overdue'],
        );
    });

    test('shutdown TTL takes precedence over provisioning TTL', () => {
        // provisioningTTL (600) would keep this; shutdownStatusTTL (300) must win because it is shutting down
        const states = [state('both', 400, { status: { provisioning: true }, isShuttingDown: true })];
        const { valid, expired } = partitionExpiredStates(ctx(), 'g', states, [false], ttls, now);
        assert.equal(valid.length, 0);
        assert.equal(expired.length, 1);
    });

    // R6: no timestamp -> explicitly expired with a warning, never a NaN comparison
    test('a state without a timestamp is expired and logged', () => {
        const c = ctx();
        const missing = state('missing', 0);
        delete missing.timestamp;
        const nulled = state('nulled', 0, { timestamp: null });
        const { valid, expired } = partitionExpiredStates(
            c,
            'g',
            [missing, nulled, state('ok', 0)],
            [false, false, false],
            ttls,
            now,
        );
        assert.deepEqual(
            valid.map((s) => s.instanceId),
            ['ok'],
        );
        assert.deepEqual(
            expired.map((s) => s.instanceId),
            ['missing', 'nulled'],
        );
        assert.equal(c.logger.warn.mock.callCount(), 2, 'one warning per timestamp-less state');
        for (const call of c.logger.warn.mock.calls) {
            assert.match(String(call.arguments[0]), /no timestamp/);
            assert.equal(call.arguments[1].group, 'g');
        }
    });

    test('handles an empty input', () => {
        const { valid, expired } = partitionExpiredStates(ctx(), 'g', [], [], ttls, now);
        assert.deepEqual(valid, []);
        assert.deepEqual(expired, []);
    });
});
