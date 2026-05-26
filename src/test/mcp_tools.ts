/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { describe, mock, beforeEach } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AutoscalerApiClient } from '../mcp/api_client';
import { registerAllTools } from '../mcp/tools';

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
            withOverrides: mock.fn(function () {
                return this;
            }),
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
        test('returns formatted audit', async () => {
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
            clientMock.getGroupAudit.mock.mockImplementation(() => Promise.resolve(audit));

            const tool = getTool(server, 'get_group_audit');
            const result = await tool.handler({ name: 'g1', include_instance_audit: false }, {});

            const text = result.content[0].text;
            assert.ok(text.includes('# Audit: g1'));
            assert.ok(text.includes('scaleUp'));
            assert.ok(text.includes('0.9, 0.85'));
        });
    });

    describe('create_group', () => {
        test('validates desiredCount is within range', async () => {
            const tool = getTool(server, 'create_group');
            const result = await tool.handler(
                {
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
                    minDesired: 5,
                    maxDesired: 10,
                    desiredCount: 2, // below min
                    scaleUpQuantity: 1,
                    scaleDownQuantity: 1,
                    scaleUpThreshold: 0.8,
                    scaleDownThreshold: 0.2,
                    scalePeriod: 60,
                    scaleUpPeriodsCount: 2,
                    scaleDownPeriodsCount: 4,
                    tags: {},
                },
                {},
            );

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('Validation error'));
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 0);
        });

        test('creates group with valid params', async () => {
            clientMock.upsertGroup.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'create_group');
            const result = await tool.handler(
                {
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
                },
                {},
            );

            assert.ok(!result.isError);
            assert.ok(result.content[0].text.includes('created successfully'));
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 1);
        });
    });

    describe('update_group', () => {
        test('merges fields with existing group', async () => {
            const existing = makeGroup();
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(existing));
            clientMock.upsertGroup.mock.mockImplementation(() => Promise.resolve());

            const tool = getTool(server, 'update_group');
            const result = await tool.handler({ name: 'test-group', desiredCount: 7 }, {});

            assert.ok(!result.isError);
            assert.strictEqual(clientMock.upsertGroup.mock.calls.length, 1);
            const [, group] = clientMock.upsertGroup.mock.calls[0].arguments;
            assert.strictEqual(group.scalingOptions.desiredCount, 7);
            // Other fields preserved
            assert.strictEqual(group.type, 'jibri');
            assert.strictEqual(group.scalingOptions.minDesired, 1);
        });

        test('returns error for missing group', async () => {
            clientMock.getGroup.mock.mockImplementation(() => Promise.resolve(null));

            const tool = getTool(server, 'update_group');
            const result = await tool.handler({ name: 'missing', desiredCount: 5 }, {});

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('not found'));
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

    describe('tool registration', () => {
        test('all 10 tools are registered', () => {
            const expectedTools = [
                'search_groups',
                'describe_group',
                'get_group_report',
                'get_group_audit',
                'create_group',
                'update_group',
                'update_scaling_options',
                'update_desired_count',
                'update_scaling_activities',
                'delete_group',
            ];
            for (const name of expectedTools) {
                assert.ok(server._registeredTools[name], `Tool '${name}' should be registered`);
            }
        });
    });
});
