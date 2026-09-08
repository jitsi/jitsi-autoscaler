/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { beforeEach, describe, mock } from 'node:test';

import GroupReportGenerator from '../group_report';

describe('GroupReportGenerator', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const groupName = 'group';
    const baseGroup = {
        name: groupName,
        type: 'jibri',
        region: 'default',
        environment: 'test',
        scalingOptions: { minDesired: 1, maxDesired: 10, desiredCount: 3 },
    };

    // Per-instance answers the stubbed managers hand back, keyed by instance id.
    let shutdownStatusById;
    let shutdownConfirmationById;
    let protectedById;
    let reconfigureDateById;

    let instanceTracker;
    let shutdownManager;
    let reconfigureManager;
    let metricsLoop;
    let generator;

    function state(instanceId, overrides = {}) {
        return {
            instanceId,
            instanceType: baseGroup.type,
            status: { provisioning: false },
            metadata: { group: groupName },
            ...overrides,
        };
    }

    function byId(report, instanceId) {
        const found = report.instances.find((i) => i.instanceId === instanceId);
        assert.ok(found, `expected instance ${instanceId} in report`);
        return found;
    }

    beforeEach(() => {
        context.logger.info.mock.resetCalls();
        context.logger.error.mock.resetCalls();
        shutdownStatusById = {};
        shutdownConfirmationById = {};
        protectedById = {};
        reconfigureDateById = {};

        instanceTracker = { trimCurrent: mock.fn(() => Promise.resolve([])) };
        shutdownManager = {
            getShutdownStatuses: mock.fn((_ctx, _group, ids) =>
                Promise.resolve(ids.map((id) => !!shutdownStatusById[id])),
            ),
            getShutdownConfirmations: mock.fn((_ctx, _group, ids) =>
                Promise.resolve(ids.map((id) => shutdownConfirmationById[id] || false)),
            ),
            areScaleDownProtected: mock.fn((_ctx, _group, ids) =>
                Promise.resolve(ids.map((id) => !!protectedById[id])),
            ),
        };
        reconfigureManager = {
            getReconfigureDates: mock.fn((_ctx, _group, ids) =>
                Promise.resolve(ids.map((id) => reconfigureDateById[id] || '')),
            ),
        };
        metricsLoop = { getCloudInstances: mock.fn(() => Promise.resolve([])) };

        generator = new GroupReportGenerator({ instanceTracker, shutdownManager, reconfigureManager, metricsLoop });
    });

    describe('guards', () => {
        test('throws when the group is missing', async () => {
            await assert.rejects(generator.generateReport(context, undefined, []), /Group not found/);
        });

        test('throws when the group has no type', async () => {
            await assert.rejects(
                generator.generateReport(context, { ...baseGroup, type: undefined }, []),
                /Only typed groups are supported/,
            );
        });
    });

    describe('empty group', () => {
        test('produces zero counts and no instances instead of throwing', async () => {
            const report = await generator.generateReport(context, baseGroup, []);

            assert.deepStrictEqual(report, {
                groupName,
                desiredCount: 3,
                count: 0,
                cloudCount: 0,
                provisioningCount: 0,
                availableCount: 0,
                busyCount: 0,
                expiredCount: 0,
                unTrackedCount: 0,
                shuttingDownCount: 0,
                shutdownCount: 0,
                shutdownErrorCount: 0,
                reconfigureErrorCount: 0,
                reconfigureScheduledCount: 0,
                scaleDownProtectedCount: 0,
                instances: [],
            });
            assert.deepStrictEqual(instanceTracker.trimCurrent.mock.calls[0].arguments, [context, groupName, false]);
            // Cloud instances were supplied, so the metrics loop is not consulted.
            assert.strictEqual(metricsLoop.getCloudInstances.mock.callCount(), 0);
        });

        test('falls back to the metrics loop cloud inventory when none is supplied', async () => {
            metricsLoop.getCloudInstances = mock.fn(() =>
                Promise.resolve([{ instanceId: 'c-1', displayName: 'orphan', cloudStatus: 'RUNNING' }]),
            );
            generator = new GroupReportGenerator({ instanceTracker, shutdownManager, reconfigureManager, metricsLoop });

            const report = await generator.generateReport(context, baseGroup, undefined);

            assert.deepStrictEqual(metricsLoop.getCloudInstances.mock.calls[0].arguments, [groupName]);
            assert.strictEqual(report.count, 0);
            assert.strictEqual(report.cloudCount, 1);
            assert.strictEqual(report.unTrackedCount, 1);
            assert.strictEqual(report.instances.length, 1);
        });
    });

    describe('jibri group with mixed instance states', () => {
        const instanceStates = [
            state('i-prov', {
                status: { provisioning: true },
                metadata: { group: groupName, name: 'prov-host' },
                reconfigureError: true,
            }),
            state('i-idle', {
                status: {
                    provisioning: false,
                    jibriStatus: { busyStatus: 'IDLE', health: { healthStatus: 'HEALTHY' } },
                },
                metadata: {
                    group: groupName,
                    name: 'idle-host',
                    publicIp: '203.0.113.10',
                    privateIp: '10.0.0.10',
                    version: '1.2.3',
                },
            }),
            state('i-busy', {
                status: {
                    provisioning: false,
                    jibriStatus: { busyStatus: 'BUSY', health: { healthStatus: 'HEALTHY' } },
                },
            }),
            state('i-expired', {
                status: {
                    provisioning: false,
                    jibriStatus: { busyStatus: 'EXPIRED', health: { healthStatus: 'HEALTHY' } },
                },
            }),
            state('i-shut', {
                shutdownStatus: true,
                shutdownError: true,
                status: {
                    provisioning: false,
                    jibriStatus: { busyStatus: 'IDLE', health: { healthStatus: 'HEALTHY' } },
                },
            }),
            state('i-done', { shutdownComplete: '2026-09-01T00:00:00.000Z', status: { provisioning: false } }),
            state('i-nostatus', { status: { provisioning: false } }),
        ];
        const cloudInstances = [
            { instanceId: 'i-prov', displayName: 'prov-display', cloudStatus: 'PROVISIONING' },
            { instanceId: 'i-idle', displayName: 'idle-display', cloudStatus: 'RUNNING' },
            { instanceId: 'i-busy', displayName: 'busy-display', cloudStatus: 'running' },
            { instanceId: 'i-shut', displayName: 'shut-display', cloudStatus: 'RUNNING' },
            { instanceId: 'i-done', displayName: 'done-display', cloudStatus: 'TERMINATED' },
            { instanceId: 'c-untracked', displayName: 'orphan', cloudStatus: 'RUNNING' },
            { instanceId: 'c-stopped', displayName: 'stopped-orphan', cloudStatus: 'STOPPED' },
        ];

        beforeEach(() => {
            instanceTracker.trimCurrent = mock.fn(() => Promise.resolve(instanceStates));
            shutdownStatusById['i-busy'] = true; // store says shutting down even though the state does not
            shutdownConfirmationById['i-done'] = '2026-09-01T00:00:00.000Z';
            protectedById['i-idle'] = true;
            reconfigureDateById['i-busy'] = '2026-09-08T00:00:00.000Z';
            generator = new GroupReportGenerator({ instanceTracker, shutdownManager, reconfigureManager, metricsLoop });
        });

        test('counts instances by status', async () => {
            const report = await generator.generateReport(context, baseGroup, cloudInstances);

            assert.strictEqual(report.groupName, groupName);
            assert.strictEqual(report.desiredCount, 3);
            // Only sidecar-tracked states count toward `count`; cloud-only instances are extra rows.
            assert.strictEqual(report.count, 7);
            assert.strictEqual(report.instances.length, 9);
            // PROVISIONING/RUNNING (case-insensitive) in the cloud: i-prov, i-idle, i-busy, i-shut, c-untracked.
            assert.strictEqual(report.cloudCount, 5);
            // Running in the cloud but unknown to the sidecars: c-untracked only (c-stopped is not running).
            assert.strictEqual(report.unTrackedCount, 1);
            assert.strictEqual(report.provisioningCount, 1);
            assert.strictEqual(report.availableCount, 1); // i-idle; i-shut is IDLE but reported as SHUTDOWN
            assert.strictEqual(report.busyCount, 1);
            assert.strictEqual(report.expiredCount, 1);
            assert.strictEqual(report.shuttingDownCount, 2); // i-shut (state) + i-busy (store)
            assert.strictEqual(report.shutdownCount, 1); // i-done
            assert.strictEqual(report.shutdownErrorCount, 1);
            assert.strictEqual(report.reconfigureErrorCount, 1);
            assert.strictEqual(report.reconfigureScheduledCount, 1);
            assert.strictEqual(report.scaleDownProtectedCount, 1);
            assert.ok(
                context.logger.info.mock.calls.some((c) => String(c.arguments[0]).includes('untracked instance')),
            );
            assert.strictEqual(context.logger.error.mock.callCount(), 0);
        });

        test('lists tracked instances first, then cloud-only ones, and queries the managers with that id list', async () => {
            const report = await generator.generateReport(context, baseGroup, cloudInstances);

            const expectedIds = [
                'i-prov',
                'i-idle',
                'i-busy',
                'i-expired',
                'i-shut',
                'i-done',
                'i-nostatus',
                'c-untracked',
                'c-stopped',
            ];
            assert.deepStrictEqual(
                report.instances.map((i) => i.instanceId),
                expectedIds,
            );
            for (const stub of [
                shutdownManager.getShutdownStatuses,
                shutdownManager.getShutdownConfirmations,
                shutdownManager.areScaleDownProtected,
                reconfigureManager.getReconfigureDates,
            ]) {
                assert.strictEqual(stub.mock.callCount(), 1);
                assert.deepStrictEqual(stub.mock.calls[0].arguments, [context, groupName, expectedIds]);
            }
        });

        test('fills per-instance detail flags', async () => {
            const report = await generator.generateReport(context, baseGroup, cloudInstances);

            const idle = byId(report, 'i-idle');
            assert.strictEqual(idle.scaleStatus, 'IDLE');
            assert.strictEqual(idle.cloudStatus, 'RUNNING');
            assert.strictEqual(idle.displayName, 'idle-display');
            assert.strictEqual(idle.instanceName, 'idle-host');
            assert.strictEqual(idle.publicIp, '203.0.113.10');
            assert.strictEqual(idle.privateIp, '10.0.0.10');
            assert.strictEqual(idle.version, '1.2.3');
            assert.strictEqual(idle.group, groupName);
            assert.strictEqual(idle.isShuttingDown, false);
            assert.strictEqual(idle.isScaleDownProtected, true);
            assert.strictEqual(idle.shutdownComplete, false);
            assert.strictEqual(idle.reconfigureScheduled, '');

            const busy = byId(report, 'i-busy');
            assert.strictEqual(busy.scaleStatus, 'BUSY');
            assert.strictEqual(busy.cloudStatus, 'running');
            assert.strictEqual(busy.isShuttingDown, true, 'store shutdown status overrides a false state flag');
            assert.strictEqual(busy.isScaleDownProtected, false);
            assert.strictEqual(busy.reconfigureScheduled, '2026-09-08T00:00:00.000Z');

            const prov = byId(report, 'i-prov');
            assert.strictEqual(prov.scaleStatus, 'PROVISIONING');
            assert.strictEqual(prov.cloudStatus, 'PROVISIONING');
            assert.strictEqual(prov.instanceName, 'prov-host');
            assert.strictEqual(prov.reconfigureError, true);

            const expired = byId(report, 'i-expired');
            assert.strictEqual(expired.scaleStatus, 'EXPIRED');
            assert.strictEqual(expired.cloudStatus, 'unknown', 'no cloud record leaves the default cloud status');
            assert.strictEqual(expired.displayName, 'unknown');

            const shut = byId(report, 'i-shut');
            assert.strictEqual(shut.scaleStatus, 'SHUTDOWN', 'shutdown takes precedence over the jibri busy status');
            assert.strictEqual(shut.isShuttingDown, true);
            assert.strictEqual(shut.shutdownError, true);

            const done = byId(report, 'i-done');
            assert.strictEqual(done.scaleStatus, 'SHUTDOWN COMPLETE');
            assert.strictEqual(done.shutdownComplete, '2026-09-01T00:00:00.000Z');
            assert.strictEqual(done.cloudStatus, 'TERMINATED');

            const noStatus = byId(report, 'i-nostatus');
            assert.strictEqual(
                noStatus.scaleStatus,
                'SIDECAR_RUNNING',
                'a jibri sidecar without a busy status is running',
            );

            const untracked = byId(report, 'c-untracked');
            assert.deepStrictEqual(untracked, {
                instanceId: 'c-untracked',
                displayName: 'orphan',
                scaleStatus: 'unknown',
                cloudStatus: 'RUNNING',
                isShuttingDown: false,
                isScaleDownProtected: false,
                shutdownComplete: false,
                reconfigureScheduled: '',
            });
            assert.strictEqual(untracked.group, undefined);
        });
    });

    describe('stats-based group types', () => {
        const jvbGroup = { ...baseGroup, type: 'JVB' };

        test('derives scale status from stress stats and does not count jibri availability', async () => {
            instanceTracker.trimCurrent = mock.fn(() =>
                Promise.resolve([
                    state('i-online', { status: { provisioning: false } }),
                    state('i-sidecar', {
                        status: { provisioning: false, stats: { stress_level: 0, graceful_shutdown: false } },
                    }),
                    state('i-participants', {
                        status: {
                            provisioning: false,
                            stats: { stress_level: 0.3, graceful_shutdown: false, participants: 4 },
                        },
                    }),
                    state('i-connections', {
                        status: {
                            provisioning: false,
                            whisperStatus: { stress_level: 0.2, graceful_shutdown: false, connections: 2 },
                        },
                    }),
                    state('i-cpu', {
                        status: {
                            provisioning: false,
                            nomadStatus: { stress_level: 0.1, graceful_shutdown: false, allocatedCPU: 1500 },
                        },
                    }),
                    state('i-graceful', {
                        status: {
                            provisioning: false,
                            jvbStatus: { stress_level: 0.9, graceful_shutdown: true, participants: 10, conferences: 1 },
                        },
                    }),
                ]),
            );
            generator = new GroupReportGenerator({ instanceTracker, shutdownManager, reconfigureManager, metricsLoop });

            const report = await generator.generateReport(context, jvbGroup, []);

            assert.strictEqual(byId(report, 'i-online').scaleStatus, 'ONLINE');
            assert.strictEqual(byId(report, 'i-sidecar').scaleStatus, 'SIDECAR_RUNNING');
            assert.strictEqual(byId(report, 'i-participants').scaleStatus, 'IN USE');
            assert.strictEqual(byId(report, 'i-connections').scaleStatus, 'IN USE');
            assert.strictEqual(byId(report, 'i-cpu').scaleStatus, 'IN USE');
            assert.strictEqual(byId(report, 'i-graceful').scaleStatus, 'GRACEFUL SHUTDOWN');

            assert.strictEqual(report.count, 6);
            assert.strictEqual(report.availableCount, 0);
            assert.strictEqual(report.busyCount, 0);
            assert.strictEqual(report.expiredCount, 0);
            // No cloud records were supplied, so nothing is counted as running in the cloud or untracked.
            assert.strictEqual(report.cloudCount, 0);
            assert.strictEqual(report.unTrackedCount, 0);
            assert.strictEqual(context.logger.error.mock.callCount(), 0);
        });

        test('logs an error for an unsupported group type but still returns the report', async () => {
            instanceTracker.trimCurrent = mock.fn(() =>
                Promise.resolve([state('i-1', { status: { provisioning: false } })]),
            );
            generator = new GroupReportGenerator({ instanceTracker, shutdownManager, reconfigureManager, metricsLoop });

            const report = await generator.generateReport(context, { ...baseGroup, type: 'mystery' }, []);

            assert.strictEqual(report.count, 1);
            assert.strictEqual(byId(report, 'i-1').scaleStatus, 'unknown');
            // Once while building the instance report and once while counting.
            assert.strictEqual(context.logger.error.mock.callCount(), 2);
        });
    });
});
