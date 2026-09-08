/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, beforeEach, describe, mock } from 'node:test';

import Audit from '../audit';
import { MockRedisClient } from './mock-redis-client';

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The shared mock only understands a trailing '*' glob and has no zscore, both of which the audit
// reader relies on (it scans `audit:<group>:*:*` and looks up scores for timestamp-less markers).
class AuditRedisClient extends MockRedisClient {
    async keys(pattern: string): Promise<string[]> {
        const all = await super.keys('*');
        const re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
        return all.filter((key) => re.test(key));
    }

    async zscore(key: string, member: string): Promise<string | null> {
        const set = this.sortedSets.get(key);
        if (!set || !set.has(member)) {
            return null;
        }
        return String(set.get(member));
    }
}

describe('Audit', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const groupName = 'group';
    const auditTTL = 3600;
    const groupRelatedDataTTL = 7 * 24 * 3600;
    const redisScanCount = 100;

    let redisClient;
    let audit;

    // Fixed wall clock so timestamps written by the module are deterministic.
    const T0 = Date.parse('2026-09-08T12:00:00.000Z');

    async function ttlOf(key) {
        return redisClient.ttl(key);
    }

    async function readJson(key) {
        const raw = await redisClient.get(key);
        return raw === null ? null : JSON.parse(raw);
    }

    beforeEach(() => {
        context.logger.info.mock.resetCalls();
        redisClient = new AuditRedisClient();
        audit = new Audit({ redisClient, redisScanCount, auditTTL, groupRelatedDataTTL });
        mock.timers.enable({ apis: ['Date'], now: T0 });
    });

    afterEach(() => {
        mock.timers.reset();
    });

    describe('instance audit writers', () => {
        test('saveLaunchEvent writes request-to-launch under audit:<group>:<instance> with the audit ttl', async () => {
            assert.strictEqual(await audit.saveLaunchEvent(groupName, 'i-1'), true);

            const key = `audit:${groupName}:i-1:request-to-launch`;
            assert.deepStrictEqual(await readJson(key), {
                instanceId: 'i-1',
                type: 'request-to-launch',
                timestamp: T0,
            });
            assert.strictEqual(await ttlOf(key), auditTTL);
        });

        test('saveLatestStatus writes latest-status with the state and refreshes sibling key ttls', async () => {
            // A launch record that is about to expire.
            await redisClient.set(
                `audit:${groupName}:i-1:request-to-launch`,
                JSON.stringify({ instanceId: 'i-1', type: 'request-to-launch', timestamp: T0 - 1000 }),
                'EX',
                5,
            );
            assert.strictEqual(await ttlOf(`audit:${groupName}:i-1:request-to-launch`), 5);

            const state = {
                instanceId: 'i-1',
                instanceType: 'JVB',
                status: { provisioning: false, stats: { stress_level: 0.2, graceful_shutdown: false } },
                metadata: { group: groupName },
            };
            assert.strictEqual(await audit.saveLatestStatus(groupName, 'i-1', state), true);
            // The ttl refresh pipeline is kicked off without being awaited; let it drain.
            await new Promise((resolve) => setImmediate(resolve));

            const latest = await readJson(`audit:${groupName}:i-1:latest-status`);
            assert.deepStrictEqual(latest, { instanceId: 'i-1', type: 'latest-status', timestamp: T0, state });
            assert.strictEqual(await ttlOf(`audit:${groupName}:i-1:latest-status`), auditTTL);
            assert.strictEqual(await ttlOf(`audit:${groupName}:i-1:request-to-launch`), auditTTL);
            // Sibling keys that do not exist are not created by the refresh.
            assert.strictEqual(await redisClient.get(`audit:${groupName}:i-1:request-to-terminate`), null);
        });

        test('saveShutdownEvents writes one request-to-terminate per instance keyed by each instance group', async () => {
            await audit.saveShutdownEvents([
                { instanceId: 'i-1', instanceType: 'JVB', group: groupName },
                { instanceId: 'i-2', instanceType: 'JVB', group: 'other-group' },
            ]);

            assert.deepStrictEqual(await readJson(`audit:${groupName}:i-1:request-to-terminate`), {
                instanceId: 'i-1',
                type: 'request-to-terminate',
                timestamp: T0,
            });
            assert.deepStrictEqual(await readJson(`audit:other-group:i-2:request-to-terminate`), {
                instanceId: 'i-2',
                type: 'request-to-terminate',
                timestamp: T0,
            });
            assert.strictEqual(await ttlOf(`audit:${groupName}:i-1:request-to-terminate`), auditTTL);
            assert.strictEqual(await ttlOf(`audit:other-group:i-2:request-to-terminate`), auditTTL);
        });

        test('saveShutdownConfirmationEvents writes confirmation-of-termination per instance', async () => {
            await audit.saveShutdownConfirmationEvents([{ instanceId: 'i-1', instanceType: 'JVB', group: groupName }]);

            const key = `audit:${groupName}:i-1:confirmation-of-termination`;
            assert.deepStrictEqual(await readJson(key), {
                instanceId: 'i-1',
                type: 'confirmation-of-termination',
                timestamp: T0,
            });
            assert.strictEqual(await ttlOf(key), auditTTL);
        });

        test('saveReconfigureEvents and saveUnsetReconfigureEvents write the reconfigure pair', async () => {
            await audit.saveReconfigureEvents([{ instanceId: 'i-1', instanceType: 'JVB', group: groupName }]);
            mock.timers.tick(5000);
            await audit.saveUnsetReconfigureEvents('i-1', groupName);

            assert.deepStrictEqual(await readJson(`audit:${groupName}:i-1:request-to-reconfigure`), {
                instanceId: 'i-1',
                type: 'request-to-reconfigure',
                timestamp: T0,
            });
            assert.deepStrictEqual(await readJson(`audit:${groupName}:i-1:reconfigure-complete`), {
                instanceId: 'i-1',
                type: 'reconfigure-complete',
                timestamp: T0 + 5000,
            });
            // The clock moved 5s between the two writes, so the first key has 5s less remaining.
            assert.strictEqual(await ttlOf(`audit:${groupName}:i-1:request-to-reconfigure`), auditTTL - 5);
            assert.strictEqual(await ttlOf(`audit:${groupName}:i-1:reconfigure-complete`), auditTTL);
        });

        test('bulk writers with an empty list write nothing', async () => {
            await audit.saveShutdownEvents([]);
            await audit.saveShutdownConfirmationEvents([]);
            await audit.saveReconfigureEvents([]);

            assert.deepStrictEqual(await redisClient.keys('*'), []);
        });

        test('setInstanceValue throws when redis does not acknowledge the write', async () => {
            const failing = { set: mock.fn(() => Promise.resolve(null)) };
            const failingAudit = new Audit({ redisClient: failing, redisScanCount, auditTTL, groupRelatedDataTTL });

            await assert.rejects(
                failingAudit.saveLaunchEvent(groupName, 'i-1'),
                new RegExp(`unable to set audit:${groupName}:i-1:request-to-launch`),
            );
        });
    });

    describe('instance audit readers', () => {
        test('generateInstanceAudit returns an empty list for a group with no records', async () => {
            assert.deepStrictEqual(await audit.generateInstanceAudit(context, groupName), []);
        });

        test('getInstanceAudit only returns records for the requested group', async () => {
            await audit.saveLaunchEvent(groupName, 'i-1');
            await audit.saveLaunchEvent('other-group', 'i-9');

            const records = await audit.getInstanceAudit(context, groupName);

            assert.deepStrictEqual(records, [{ instanceId: 'i-1', type: 'request-to-launch', timestamp: T0 }]);
        });

        test('generateInstanceAudit merges each instance lifecycle into ISO timestamps, ordered by earliest event', async () => {
            const state = {
                instanceId: 'i-1',
                instanceType: 'JVB',
                status: { provisioning: false },
                metadata: { group: groupName },
            };

            // i-2 is launched first, so it must come first in the report even though i-1 has more events.
            await audit.saveLaunchEvent(groupName, 'i-2');
            mock.timers.tick(1000);
            await audit.saveLaunchEvent(groupName, 'i-1');
            mock.timers.tick(1000);
            await audit.saveReconfigureEvents([{ instanceId: 'i-1', instanceType: 'JVB', group: groupName }]);
            mock.timers.tick(1000);
            await audit.saveUnsetReconfigureEvents('i-1', groupName);
            mock.timers.tick(1000);
            await audit.saveShutdownEvents([{ instanceId: 'i-1', instanceType: 'JVB', group: groupName }]);
            mock.timers.tick(1000);
            await audit.saveLatestStatus(groupName, 'i-1', state);
            await new Promise((resolve) => setImmediate(resolve));
            mock.timers.tick(1000);
            await audit.saveShutdownConfirmationEvents([{ instanceId: 'i-1', instanceType: 'JVB', group: groupName }]);
            // Noise from another group must not leak in.
            await audit.saveLaunchEvent('other-group', 'i-9');

            const report = await audit.generateInstanceAudit(context, groupName);

            assert.deepStrictEqual(
                report.map((r) => r.instanceId),
                ['i-2', 'i-1'],
            );
            assert.deepStrictEqual(report[0], {
                instanceId: 'i-2',
                requestToLaunch: new Date(T0).toISOString(),
                latestStatus: 'unknown',
                requestToTerminate: 'unknown',
                requestToReconfigure: 'unknown',
                reconfigureComplete: 'unknown',
                terminationConfirmation: 'unknown',
            });
            assert.deepStrictEqual(report[1], {
                instanceId: 'i-1',
                requestToLaunch: new Date(T0 + 1000).toISOString(),
                requestToReconfigure: new Date(T0 + 2000).toISOString(),
                reconfigureComplete: new Date(T0 + 3000).toISOString(),
                requestToTerminate: new Date(T0 + 4000).toISOString(),
                latestStatus: new Date(T0 + 5000).toISOString(),
                terminationConfirmation: new Date(T0 + 6000).toISOString(),
                latestStatusInfo: state,
            });
        });
    });

    describe('group audit writers', () => {
        const actionsKey = `group-audit-actions:${groupName}`;

        test('saveLauncherActionItem adds a launcher-action-item scored by the item timestamp', async () => {
            const item = { timestamp: T0 - 30_000, actionType: 'launch', count: 2, desiredCount: 4, scaleQuantity: 2 };

            assert.strictEqual(await audit.saveLauncherActionItem(groupName, item), true);

            const members = await redisClient.zrange(actionsKey, 0, -1);
            assert.strictEqual(members.length, 1);
            assert.deepStrictEqual(JSON.parse(members[0]), {
                groupName,
                type: 'launcher-action-item',
                timestamp: item.timestamp,
                launcherActionItem: item,
            });
            assert.strictEqual(await redisClient.zscore(actionsKey, members[0]), String(item.timestamp));
        });

        test('saveAutoScalerActionItem adds an autoScaler-action-item scored by the item timestamp', async () => {
            const item = {
                timestamp: T0 - 20_000,
                actionType: 'increaseDesired',
                count: 3,
                oldDesiredCount: 3,
                newDesiredCount: 5,
                scaleMetrics: [0.9, 0.8],
            };

            assert.strictEqual(await audit.saveAutoScalerActionItem(groupName, item), true);

            const members = await redisClient.zrange(actionsKey, 0, -1);
            assert.deepStrictEqual(JSON.parse(members[0]), {
                groupName,
                type: 'autoScaler-action-item',
                timestamp: item.timestamp,
                autoScalerActionItem: item,
            });
            assert.strictEqual(await redisClient.zscore(actionsKey, members[0]), String(item.timestamp));
        });

        test('updateLastLauncherRun records a single marker scored by the wall clock and extends the key ttl', async () => {
            await audit.saveLauncherActionItem(groupName, {
                timestamp: T0 - 1000,
                actionType: 'launch',
                count: 1,
                desiredCount: 1,
                scaleQuantity: 1,
            });

            assert.strictEqual(await audit.updateLastLauncherRun(context, groupName), true);
            mock.timers.tick(60_000);
            assert.strictEqual(await audit.updateLastLauncherRun(context, groupName), true);

            const members = (await redisClient.zrange(actionsKey, 0, -1)).map((m) => JSON.parse(m));
            const markers = members.filter((m) => m.type === 'last-launcher-run');
            // The marker carries no timestamp of its own so it is a single member whose score is bumped each run.
            assert.strictEqual(markers.length, 1);
            assert.deepStrictEqual(markers[0], { groupName, type: 'last-launcher-run' });
            assert.strictEqual(await redisClient.zscore(actionsKey, JSON.stringify(markers[0])), String(T0 + 60_000));
            assert.strictEqual(await ttlOf(actionsKey), groupRelatedDataTTL);
            assert.ok(
                context.logger.info.mock.calls.some((c) =>
                    String(c.arguments[0]).includes('Updated last launcher run'),
                ),
            );
        });

        test('updateLastAutoScalerRun records the latest scale metrics and extends the key ttl', async () => {
            // The ttl is extended before the marker is written, so the key must already exist for the
            // extension to take effect; a prior action item is the normal state of a live group.
            await audit.saveLauncherActionItem(groupName, {
                timestamp: T0 - 1000,
                actionType: 'launch',
                count: 1,
                desiredCount: 1,
                scaleQuantity: 1,
            });

            assert.strictEqual(await audit.updateLastAutoScalerRun(context, groupName, [0.1, 0.2, 0.3]), true);

            const members = (await redisClient.zrange(actionsKey, 0, -1))
                .map((m) => JSON.parse(m))
                .filter((m) => m.type === 'last-autoScaler-run');
            assert.strictEqual(members.length, 1);
            assert.deepStrictEqual(members[0], {
                groupName,
                type: 'last-autoScaler-run',
                autoScalerActionItem: {
                    timestamp: T0,
                    actionType: 'last-scale-metrics',
                    count: 0,
                    oldDesiredCount: 0,
                    newDesiredCount: 0,
                    scaleMetrics: [0.1, 0.2, 0.3],
                },
            });
            assert.strictEqual(await ttlOf(actionsKey), groupRelatedDataTTL);
        });

        test('updateLastReconfigureRequest records a marker without touching the key ttl', async () => {
            assert.strictEqual(await audit.updateLastReconfigureRequest(context, groupName), true);

            const members = (await redisClient.zrange(actionsKey, 0, -1)).map((m) => JSON.parse(m));
            assert.deepStrictEqual(members, [{ groupName, type: 'last-reconfigure-request' }]);
            assert.strictEqual(await ttlOf(actionsKey), -1);
        });

        test('last-run updates prune action items older than the audit ttl but keep recent ones', async () => {
            const stale = {
                timestamp: T0 - (auditTTL + 10) * 1000,
                actionType: 'launch',
                count: 1,
                desiredCount: 1,
                scaleQuantity: 1,
            };
            const recent = { ...stale, timestamp: T0 - (auditTTL - 10) * 1000 };
            await audit.saveLauncherActionItem(groupName, stale);
            await audit.saveLauncherActionItem(groupName, recent);

            await audit.updateLastAutoScalerRun(context, groupName, [0.5]);

            const members = (await redisClient.zrange(actionsKey, 0, -1)).map((m) => JSON.parse(m));
            const launcherItems = members.filter((m) => m.type === 'launcher-action-item');
            assert.deepStrictEqual(
                launcherItems.map((m) => m.timestamp),
                [recent.timestamp],
            );
            assert.ok(
                context.logger.info.mock.calls.some((c) =>
                    String(c.arguments[0]).startsWith('Cleaned up 1 group audit actions'),
                ),
            );
        });
    });

    describe('group audit readers', () => {
        test('generateGroupAudit returns unknown markers and empty lists for a group with no records', async () => {
            assert.deepStrictEqual(await audit.generateGroupAudit(context, groupName), {
                lastLauncherRun: 'unknown',
                lastAutoScalerRun: 'unknown',
                lastReconfigureRequest: 'unknown',
                lastScaleMetrics: [],
                autoScalerActionItems: [],
                launcherActionItems: [],
            });
        });

        test('getGroupAudit backfills marker timestamps from the sorted-set score', async () => {
            await audit.updateLastReconfigureRequest(context, groupName);

            const records = await audit.getGroupAudit(context, groupName);

            assert.deepStrictEqual(records, [{ groupName, type: 'last-reconfigure-request', timestamp: T0 }]);
        });

        test('generateGroupAudit reports last-run times and returns action items newest first as ISO strings', async () => {
            const launcherA = {
                timestamp: T0 - 50_000,
                actionType: 'launch',
                count: 1,
                desiredCount: 2,
                scaleQuantity: 1,
            };
            const launcherB = {
                timestamp: T0 - 40_000,
                actionType: 'launch',
                count: 2,
                desiredCount: 4,
                scaleQuantity: 2,
            };
            const scalerA = {
                timestamp: T0 - 30_000,
                actionType: 'increaseDesired',
                count: 1,
                oldDesiredCount: 2,
                newDesiredCount: 3,
                scaleMetrics: [0.9],
            };
            const scalerB = {
                timestamp: T0 - 20_000,
                actionType: 'decreaseDesired',
                count: 1,
                oldDesiredCount: 3,
                newDesiredCount: 2,
                scaleMetrics: [0.1],
            };
            // Insert oldest-last to prove ordering comes from the timestamps, not insertion order.
            await audit.saveLauncherActionItem(groupName, launcherB);
            await audit.saveLauncherActionItem(groupName, launcherA);
            await audit.saveAutoScalerActionItem(groupName, scalerB);
            await audit.saveAutoScalerActionItem(groupName, scalerA);

            await audit.updateLastLauncherRun(context, groupName);
            mock.timers.tick(1000);
            await audit.updateLastAutoScalerRun(context, groupName, [0.4, 0.6]);
            mock.timers.tick(1000);
            await audit.updateLastReconfigureRequest(context, groupName);

            const report = await audit.generateGroupAudit(context, groupName);

            assert.strictEqual(report.lastLauncherRun, new Date(T0).toISOString());
            assert.strictEqual(report.lastAutoScalerRun, new Date(T0 + 1000).toISOString());
            assert.strictEqual(report.lastReconfigureRequest, new Date(T0 + 2000).toISOString());
            assert.deepStrictEqual(report.lastScaleMetrics, [0.4, 0.6]);
            assert.deepStrictEqual(report.launcherActionItems, [
                { ...launcherB, timestamp: new Date(launcherB.timestamp).toISOString() },
                { ...launcherA, timestamp: new Date(launcherA.timestamp).toISOString() },
            ]);
            assert.deepStrictEqual(report.autoScalerActionItems, [
                { ...scalerB, timestamp: new Date(scalerB.timestamp).toISOString() },
                { ...scalerA, timestamp: new Date(scalerA.timestamp).toISOString() },
            ]);
        });

        test('group audits are isolated per group', async () => {
            await audit.saveLauncherActionItem('other-group', {
                timestamp: T0,
                actionType: 'launch',
                count: 1,
                desiredCount: 1,
                scaleQuantity: 1,
            });

            const report = await audit.generateGroupAudit(context, groupName);

            assert.deepStrictEqual(report.launcherActionItems, []);
            assert.strictEqual(report.lastLauncherRun, 'unknown');
        });
    });
});
