/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { describe, mock, beforeEach } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AutoscalerApiClient } from '../mcp/api_client';
import { registerAllTools } from '../mcp/tools';

const ALL_TOOLS = [
    'search_groups',
    'describe_group',
    'get_group_report',
    'get_group_audit',
    'create_group',
    'update_group',
    'update_scaling_options',
    'update_desired_count',
    'update_scaling_activities',
    'update_scheduled_scaling',
    'add_scheduled_scaling_period',
    'remove_scheduled_scaling_period',
    'delete_group',
    'create_reservation',
    'list_reservations',
    'get_reservation',
    'extend_reservation',
    'cancel_reservation',
];

function makeGroup(overrides = {}) {
    return {
        id: 'test-id',
        name: 'test-group',
        type: 'jibri',
        region: 'us-east-1',
        environment: 'production',
        cloud: 'oracle',
        compartmentId: 'comp-1',
        instanceConfigurationId: 'config-1',
        enableAutoScale: true,
        enableLaunch: true,
        enableScheduler: true,
        enableUntrackedThrottle: false,
        gracePeriodTTLSec: 480,
        protectedTTLSec: 600,
        scalingOptions: {
            minDesired: 1,
            maxDesired: 10,
            desiredCount: 3,
            scaleUpQuantity: 1,
            scaleDownQuantity: 1,
            scaleUpThreshold: 0.8,
            scaleDownThreshold: 0.2,
            scalePeriod: 60,
            scaleUpPeriodsCount: 2,
            scaleDownPeriodsCount: 4,
        },
        tags: { shard: 's1' },
        scheduledScalingActivePeriod: 'weekday-peak',
        scheduledScalingBaseOptions: { minDesired: 1, maxDesired: 10, desiredCount: 2 },
        ...overrides,
    };
}

function validCreateParams(overrides = {}) {
    return {
        name: 'new-group',
        type: 'jibri',
        region: 'us-east',
        environment: 'prod',
        cloud: 'oracle',
        compartmentId: 'c1',
        instanceConfigurationId: 'ic1',
        enableAutoScale: true,
        enableLaunch: true,
        enableScheduler: true,
        enableUntrackedThrottle: false,
        enableReconfiguration: false,
        gracePeriodTTLSec: 480,
        protectedTTLSec: 600,
        minDesired: 1,
        maxDesired: 10,
        desiredCount: 3,
        scaleUpQuantity: 1,
        scaleDownQuantity: 1,
        scaleUpThreshold: 0.8,
        scaleDownThreshold: 0.2,
        scalePeriod: 60,
        scaleUpPeriodsCount: 2,
        scaleDownPeriodsCount: 4,
        tags: {},
        overwrite: false,
        ...overrides,
    };
}

function getTool(server, name) {
    const tool = server._registeredTools[name];
    assert.ok(tool, `Tool '${name}' should be registered`);
    return tool;
}

describe('MCP Tools', () => {
    let server: McpServer;
    let clientMock;

    beforeEach(() => {
        server = new McpServer({ name: 'test', version: '1.0.0' });
        clientMock = {
            listGroups: mock.fn(),
            getGroup: mock.fn(),
            upsertGroup: mock.fn(),
            deleteGroup: mock.fn(),
            updateDesiredCount: mock.fn(),
            updateScalingOptions: mock.fn(),
            updateScalingActivities: mock.fn(),
            getGroupReport: mock.fn(),
            getGroupAudit: mock.fn(),
            getInstanceAudit: mock.fn(),
            getScheduledScaling: mock.fn(),
            updateScheduledScaling: mock.fn(),
            createReservation: mock.fn(),
            listReservations: mock.fn(),
            getReservation: mock.fn(),
            extendReservation: mock.fn(),
            cancelReservation: mock.fn(),
        };
        registerAllTools(server, clientMock as unknown as AutoscalerApiClient);
    });

    describe('search_groups filtering logic', () => {
        test('filters by name pattern', async () => {
            const groups = [makeGroup({ name: 'prod-jibri-us' }), makeGroup({ name: 'staging-jibri-eu' })];
            clientMock.listGroups.mock.mockImplementation(() => Promise.resolve(groups));

            const tool = getTool(server, 'search_groups');
            const result = await tool.handler({ name_pattern: 'prod' }, {});
            assert.ok(result.content[0].text.includes('prod-jibri-us'));
            assert.ok(!result.content[0].text.includes('staging-jibri-eu'));
        });

        test('filters by type', async () => {
            const groups = [makeGroup({ name: 'g1', type: 'jibri' }), makeGroup({ name: 'g2', type: 'JVB' })];
            clientMock.listGroups.mock.mockImplementation(() => Promise.resolve(groups));

            const tool = getTool(server, 'search_groups');
            const result = await tool.handler({ type: 'JVB' }, {});
            assert.ok(result.content[0].text.includes('g2'));
            assert.ok(!result.content[0].text.includes('g1'));
        });

        test('filters by region', async () => {
            const groups = [
                makeGroup({ name: 'g1', region: 'us-east-1' }),
                makeGroup({ name: 'g2', region: 'eu-west-1' }),
            ];
            clientMock.listGroups.mock.mockImplementation(() => Promise.resolve(groups));

            const tool = getTool(server, 'search_groups');
            const result = await tool.handler({ region: 'eu-west-1' }, {});
            assert.ok(result.content[0].text.includes('g2'));
            assert.ok(!result.content[0].text.includes('g1'));
        });

        test('returns no-match message when empty', async () => {
            clientMock.listGroups.mock.mockImplementation(() => Promise.resolve([]));

            const tool = getTool(server, 'search_groups');
            const result = await tool.handler({}, {});
            assert.ok(result.content[0].text.includes('No groups found'));
        });

        test('passes tags to API', async () => {
            clientMock.listGroups.mock.mockImplementation(() => Promise.resolve([]));

            const tool = getTool(server, 'search_groups');
            await tool.handler({ tags: { env: 'prod' } }, {});

            assert.strictEqual(clientMock.listGroups.mock.calls.length, 1);
            assert.deepStrictEqual(clientMock.listGroups.mock.calls[0].arguments[0], { env: 'prod' });
        });

        test('case-insensitive type matching', async () => {
            const groups = [makeGroup({ name: 'g1', type: 'JVB' })];
            clientMock.listGroups.mock.mockImplementation(() => Promise.resolve(groups));

            const tool = getTool(server, 'search_groups');
            const result = await tool.handler({ type: 'jvb' }, {});
            assert.ok(result.content[0].text.includes('g1'));
        });
    });

    describe('describe_group', () => {
        test('returns formatted group description', async () => {
            const group = makeGroup();
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(group));
            clientMock.getScheduledScaling.mock.mockImplementation(() => Promise.resolve(null));

            const tool = getTool(server, 'describe_group');
            const result = await tool.handler({ name: 'test-group' }, {});

            const text = result.content[0].text;
            assert.ok(text.includes('# Group: test-group'));
            assert.ok(text.includes('**Type:** jibri'));
            assert.ok(text.includes('**Region:** us-east-1'));
            assert.ok(text.includes('**Desired Count:** 3'));
            assert.ok(text.includes('**AutoScale:** Enabled'));
        });

        test('returns error for missing group', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(null));

            const tool = getTool(server, 'describe_group');
            const result = await tool.handler({ name: 'missing' }, {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('not found'));
        });
    });

    describe('get_group_report', () => {
        test('returns formatted report', async () => {
            const report = {
                groupName: 'g1',
                count: 5,
                desiredCount: 5,
                provisioningCount: 1,
                availableCount: 3,
                busyCount: 1,
                instances: [
                    {
                        instanceId: 'i-1',
                        displayName: 'inst-1',
                        scaleStatus: 'IDLE',
                        cloudStatus: 'RUNNING',
                        isShuttingDown: false,
                        isScaleDownProtected: false,
                        privateIp: '10.0.0.1',
                        version: '1.0',
                    },
                ],
            };
            clientMock.getGroupReport.mock.mockImplementation(() => Promise.resolve(report));

            const tool = getTool(server, 'get_group_report');
            const result = await tool.handler({ name: 'g1' }, {});

            const text = result.content[0].text;
            assert.ok(text.includes('# Report: g1'));
            assert.ok(text.includes('**Total Tracked:** 5'));
            assert.ok(text.includes('**Available (idle):** 3'));
            assert.ok(text.includes('i-1'));
            assert.ok(text.includes('IDLE'));
        });
    });

    describe('get_group_audit', () => {
        const audit = {
            lastAutoScalerRun: '2024-01-01T00:00:00Z',
            lastLauncherRun: '2024-01-01T00:00:00Z',
            lastReconfigureRequest: '',
            autoScalerActionItems: [
                {
                    timestamp: 1704067200000,
                    actionType: 'scaleUp',
                    count: 2,
                    oldDesiredCount: 3,
                    newDesiredCount: 5,
                    scaleMetrics: [0.9, 0.85],
                },
            ],
        };

        test('returns formatted audit', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(makeGroup({ name: 'g1' })));
            clientMock.getGroupAudit.mock.mockImplementation(() => Promise.resolve(audit));

            const tool = getTool(server, 'get_group_audit');
            const result = await tool.handler({ name: 'g1', include_instance_audit: false }, {});

            assert.ok(!result.isError);
            const text = result.content[0].text;
            assert.ok(text.includes('# Audit: g1'));
            assert.ok(text.includes('scaleUp'));
            assert.ok(text.includes('0.9, 0.85'));
        });

        test('returns not-found error for unknown group even though audit endpoint returns data', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(null));
            clientMock.getGroupAudit.mock.mockImplementation(() =>
                Promise.resolve({ lastAutoScalerRun: '', lastLauncherRun: '', lastReconfigureRequest: '' }),
            );

            const tool = getTool(server, 'get_group_audit');
            const result = await tool.handler({ name: 'ghost', include_instance_audit: false }, {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes("Group 'ghost' not found"));
            assert.strictEqual(clientMock.getGroupAudit.mock.calls.length, 0);
        });
    });

    describe('create_group', () => {
        test('validates desiredCount is within range', async () => {
            const tool = getTool(server, 'create_group');
            const result = await tool.handler(
                validCreateParams({ minDesired: 5, maxDesired: 10, desiredCount: 2 }), // below min
                {},
            );

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('Validation error'));
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 0);
        });

        test('creates group with valid params when it does not exist', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(null));
            clientMock.upsertGroup.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'create_group');
            const result = await tool.handler(validCreateParams(), {});

            assert.ok(!result.isError);
            assert.ok(result.content[0].text.includes('created successfully'));
            assert.strictEqual(clientMock.getGroup.mock.calls.length, 1);
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 1);
        });

        test('refuses to clobber an existing group without overwrite', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(makeGroup({ name: 'new-group' })));
            clientMock.upsertGroup.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'create_group');
            const result = await tool.handler(validCreateParams(), {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('already exists'));
            assert.ok(result.content[0].text.includes('overwrite: true'));
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 0);
        });

        test('replaces an existing group when overwrite is true', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(makeGroup({ name: 'new-group' })));
            clientMock.upsertGroup.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'create_group');
            const result = await tool.handler(validCreateParams({ overwrite: true }), {});

            assert.ok(!result.isError);
            assert.ok(result.content[0].text.includes('replaced successfully'));
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 1);
        });
    });

    describe('update_group', () => {
        beforeEach(() => {
            clientMock.upsertGroup.mock.mockImplementation(() => Promise.resolve());
            clientMock.updateDesiredCount.mock.mockImplementation(() => Promise.resolve());
            clientMock.updateScalingOptions.mock.mockImplementation(() => Promise.resolve());
            clientMock.updateScalingActivities.mock.mockImplementation(() => Promise.resolve());
        });

        test('routes desired-count changes to the dedicated endpoint, never a full PUT', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(makeGroup()));

            const tool = getTool(server, 'update_group');
            const result = await tool.handler({ name: 'test-group', desiredCount: 7 }, {});

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 0);
            assert.strictEqual(clientMock.updateDesiredCount.mock.calls.length, 1);
            assert.deepStrictEqual(clientMock.updateDesiredCount.mock.calls[0].arguments, [
                'test-group',
                { desiredCount: 7 },
            ]);
            assert.strictEqual(clientMock.updateScalingOptions.mock.calls.length, 0);
            assert.strictEqual(clientMock.updateScalingActivities.mock.calls.length, 0);
        });

        test('routes thresholds and enable flags to their own endpoints', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(makeGroup()));

            const tool = getTool(server, 'update_group');
            const result = await tool.handler(
                { name: 'test-group', scaleUpThreshold: 0.9, scalePeriod: 120, enableAutoScale: false },
                {},
            );

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 0);
            assert.deepStrictEqual(clientMock.updateScalingOptions.mock.calls[0].arguments, [
                'test-group',
                { scaleUpThreshold: 0.9, scalePeriod: 120 },
            ]);
            assert.deepStrictEqual(clientMock.updateScalingActivities.mock.calls[0].arguments, [
                'test-group',
                { enableAutoScale: false },
            ]);
        });

        test('falls back to a full PUT only for structural fields, merging into a fresh snapshot', async () => {
            const existing = makeGroup();
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(existing));

            const tool = getTool(server, 'update_group');
            const result = await tool.handler(
                { name: 'test-group', tags: { shard: 's2' }, desiredCount: 7, enableLaunch: false },
                {},
            );

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 1);
            // No duplicate field-wise writes when the PUT already carries the change
            assert.strictEqual(clientMock.updateDesiredCount.mock.calls.length, 0);
            assert.strictEqual(clientMock.updateScalingActivities.mock.calls.length, 0);

            const [, group] = clientMock.upsertGroup.mock.calls[0].arguments;
            assert.deepStrictEqual(group.tags, { shard: 's2' });
            assert.strictEqual(group.scalingOptions.desiredCount, 7);
            assert.strictEqual(group.enableLaunch, false);
            // Untouched fields preserved, including server-managed scheduled-scaling state
            assert.strictEqual(group.type, 'jibri');
            assert.strictEqual(group.scalingOptions.minDesired, 1);
            assert.strictEqual(group.scheduledScalingActivePeriod, 'weekday-peak');
            assert.deepStrictEqual(group.scheduledScalingBaseOptions, existing.scheduledScalingBaseOptions);
            // The snapshot itself must not have been mutated
            assert.deepStrictEqual(existing.tags, { shard: 's1' });
            assert.strictEqual(existing.scalingOptions.desiredCount, 3);
        });

        test('reports no changes when only name is given', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(makeGroup()));

            const tool = getTool(server, 'update_group');
            const result = await tool.handler({ name: 'test-group' }, {});

            assert.ok(!result.isError);
            assert.ok(result.content[0].text.includes('No changes'));
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 0);
        });

        test('returns error for missing group', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(null));

            const tool = getTool(server, 'update_group');
            const result = await tool.handler({ name: 'missing', desiredCount: 5 }, {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('not found'));
            assert.strictEqual(clientMock.updateDesiredCount.mock.calls.length, 0);
        });
    });

    describe('delete_group', () => {
        test('deletes successfully', async () => {
            clientMock.deleteGroup.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'delete_group');
            const result = await tool.handler({ name: 'old-group' }, {});

            assert.ok(!result.isError);
            assert.ok(result.content[0].text.includes('deleted successfully'));
        });

        test('returns error on failure', async () => {
            clientMock.deleteGroup.mock.mockImplementation(() =>
                Promise.reject(new Error('DELETE /groups/active-group failed (409): Group has active instances')),
            );

            const tool = getTool(server, 'delete_group');
            const result = await tool.handler({ name: 'active-group' }, {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('active instances'));
        });
    });

    describe('update_scaling_options', () => {
        test('calls API with provided options', async () => {
            clientMock.updateScalingOptions.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'update_scaling_options');
            const result = await tool.handler({ name: 'g1', scaleUpThreshold: 0.9 }, {});

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.updateScalingOptions.mock.calls.length, 1);
        });
    });

    describe('update_desired_count', () => {
        test('calls API with provided values', async () => {
            clientMock.updateDesiredCount.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'update_desired_count');
            const result = await tool.handler({ name: 'g1', desiredCount: 10, maxDesired: 20 }, {});

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.updateDesiredCount.mock.calls.length, 1);
        });
    });

    describe('update_scaling_activities', () => {
        test('calls API with provided activities', async () => {
            clientMock.updateScalingActivities.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'update_scaling_activities');
            const result = await tool.handler({ name: 'g1', enableAutoScale: false }, {});

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.updateScalingActivities.mock.calls.length, 1);
        });
    });

    describe('add_scheduled_scaling_period', () => {
        const periodParams = {
            name: 'g1',
            period_name: 'night',
            dayOfWeek: [1, 2, 3],
            startHour: 22,
            endHour: 6,
        };

        test('creates a new config using the enabled param when none exists', async () => {
            clientMock.getScheduledScaling.mock.mockImplementation(() => Promise.resolve(null));
            clientMock.updateScheduledScaling.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'add_scheduled_scaling_period');
            const result = await tool.handler({ ...periodParams, enabled: false, timezone: 'Europe/Berlin' }, {});

            assert.ok(!result.isError);
            const [, config] = clientMock.updateScheduledScaling.mock.calls[0].arguments;
            assert.strictEqual(config.enabled, false);
            assert.strictEqual(config.timezone, 'Europe/Berlin');
            assert.strictEqual(config.periods.length, 1);
            assert.strictEqual(config.periods[0].name, 'night');
            assert.ok(result.content[0].text.includes('Created new scheduled scaling config (enabled=false'));
        });

        test('defaults a new config to enabled=true', async () => {
            clientMock.getScheduledScaling.mock.mockImplementation(() => Promise.resolve(null));
            clientMock.updateScheduledScaling.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'add_scheduled_scaling_period');
            await tool.handler({ ...periodParams, enabled: true }, {});

            const [, config] = clientMock.updateScheduledScaling.mock.calls[0].arguments;
            assert.strictEqual(config.enabled, true);
        });

        test('ignores enabled/timezone when a config already exists', async () => {
            clientMock.getScheduledScaling.mock.mockImplementation(() =>
                Promise.resolve({ enabled: true, timezone: 'UTC', periods: [] }),
            );
            clientMock.updateScheduledScaling.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'add_scheduled_scaling_period');
            await tool.handler({ ...periodParams, enabled: false, timezone: 'Asia/Tokyo' }, {});

            const [, config] = clientMock.updateScheduledScaling.mock.calls[0].arguments;
            assert.strictEqual(config.enabled, true);
            assert.strictEqual(config.timezone, 'UTC');
        });

        test('rejects duplicate period names', async () => {
            clientMock.getScheduledScaling.mock.mockImplementation(() =>
                Promise.resolve({
                    enabled: true,
                    timezone: 'UTC',
                    periods: [
                        { name: 'night', dayOfWeek: [1], startHour: 0, endHour: 1, priority: 1, scalingOptions: {} },
                    ],
                }),
            );

            const tool = getTool(server, 'add_scheduled_scaling_period');
            const result = await tool.handler({ ...periodParams, enabled: true }, {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('already exists'));
            assert.strictEqual(clientMock.updateScheduledScaling.mock.calls.length, 0);
        });
    });

    describe('tool registration', () => {
        test('exactly the 18 expected tools are registered', () => {
            const registered = Object.keys(server._registeredTools).sort();
            assert.strictEqual(registered.length, 18);
            assert.deepStrictEqual(registered, [...ALL_TOOLS].sort());
        });

        test('no tool exposes base_url or auth_token override params', () => {
            for (const name of ALL_TOOLS) {
                const shape = getTool(server, name).inputSchema?.shape ?? {};
                assert.ok(!('base_url' in shape), `${name} should not accept base_url`);
                assert.ok(!('auth_token' in shape), `${name} should not accept auth_token`);
            }
        });
    });

    describe('tool annotations', () => {
        test('read-only tools are annotated as such', () => {
            for (const name of [
                'search_groups',
                'describe_group',
                'get_group_report',
                'get_group_audit',
                'list_reservations',
                'get_reservation',
            ]) {
                const { annotations } = getTool(server, name);
                assert.ok(annotations, `${name} should have annotations`);
                assert.strictEqual(annotations.readOnlyHint, true, `${name} readOnlyHint`);
                assert.strictEqual(annotations.destructiveHint, false, `${name} destructiveHint`);
            }
        });

        test('destructive tools are annotated as such', () => {
            for (const name of ['delete_group', 'cancel_reservation', 'create_group']) {
                const { annotations } = getTool(server, name);
                assert.ok(annotations, `${name} should have annotations`);
                assert.strictEqual(annotations.readOnlyHint, false, `${name} readOnlyHint`);
                assert.strictEqual(annotations.destructiveHint, true, `${name} destructiveHint`);
            }
        });

        test('field-wise update tools are non-destructive and idempotent', () => {
            for (const name of [
                'update_group',
                'update_scaling_options',
                'update_desired_count',
                'update_scaling_activities',
                'update_scheduled_scaling',
            ]) {
                const { annotations } = getTool(server, name);
                assert.strictEqual(annotations.readOnlyHint, false, `${name} readOnlyHint`);
                assert.strictEqual(annotations.destructiveHint, false, `${name} destructiveHint`);
                assert.strictEqual(annotations.idempotentHint, true, `${name} idempotentHint`);
            }
        });

        test('every tool carries annotations with openWorldHint=false', () => {
            for (const name of ALL_TOOLS) {
                const { annotations } = getTool(server, name);
                assert.ok(annotations, `${name} should have annotations`);
                assert.strictEqual(annotations.openWorldHint, false, `${name} openWorldHint`);
            }
        });
    });
});
