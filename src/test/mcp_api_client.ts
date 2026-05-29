/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import test, { afterEach, beforeEach, describe, mock } from 'node:test';
import { AutoscalerApiClient } from '../mcp/api_client';
import type { InstanceGroup, ScheduledScalingConfig } from '../instance_store';

// Mock fetch globally
let fetchMock: ReturnType<typeof mock.fn>;
const originalFetch = global.fetch;

function mockFetchResponse(
    status: number,
    body: unknown,
    contentType = 'application/json',
): ReturnType<typeof mock.fn> {
    return mock.fn(() =>
        Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
                get: (name: string) => (name === 'content-type' ? contentType : null),
            },
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        }),
    );
}

describe('AutoscalerApiClient', () => {
    let client: AutoscalerApiClient;

    beforeEach(() => {
        client = new AutoscalerApiClient('http://localhost:3000', 'test-token');
    });

    afterEach(() => {
        global.fetch = originalFetch;
        mock.restoreAll();
    });

    describe('listGroups', () => {
        test('returns groups from the API', async () => {
            const groups = [
                { name: 'group1', type: 'jibri', region: 'us-east' },
                { name: 'group2', type: 'JVB', region: 'eu-west' },
            ];
            fetchMock = mockFetchResponse(200, { instanceGroups: groups });
            global.fetch = fetchMock;

            const result = await client.listGroups();

            assert.deepStrictEqual(result, groups);
            assert.strictEqual(fetchMock.mock.calls.length, 1);
            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups');
            assert.strictEqual(opts.method, 'GET');
            assert.strictEqual(opts.headers.Authorization, 'Bearer test-token');
        });

        test('appends tag query params', async () => {
            fetchMock = mockFetchResponse(200, { instanceGroups: [] });
            global.fetch = fetchMock;

            await client.listGroups({ environment: 'prod', shard: 's1' });

            const [url] = fetchMock.mock.calls[0].arguments;
            assert.ok(url.includes('tag.environment=prod'));
            assert.ok(url.includes('tag.shard=s1'));
        });
    });

    describe('getGroup', () => {
        test('returns group when found', async () => {
            const group = { name: 'test-group', type: 'jibri' };
            fetchMock = mockFetchResponse(200, { instanceGroup: group });
            global.fetch = fetchMock;

            const result = await client.getGroup('test-group');

            assert.deepStrictEqual(result, group);
            const [url] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/test-group');
        });

        test('returns null for 404', async () => {
            fetchMock = mockFetchResponse(404, 'Not Found');
            global.fetch = fetchMock;

            const result = await client.getGroup('nonexistent');

            assert.strictEqual(result, null);
        });
    });

    describe('upsertGroup', () => {
        test('sends PUT with group body', async () => {
            fetchMock = mockFetchResponse(200, undefined, 'text/plain');
            global.fetch = fetchMock;

            const group = { name: 'new-group', type: 'JVB' };
            await client.upsertGroup('new-group', group as InstanceGroup);

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/new-group');
            assert.strictEqual(opts.method, 'PUT');
            assert.deepStrictEqual(JSON.parse(opts.body), group);
        });
    });

    describe('deleteGroup', () => {
        test('sends DELETE request', async () => {
            fetchMock = mockFetchResponse(200, undefined, 'text/plain');
            global.fetch = fetchMock;

            await client.deleteGroup('old-group');

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/old-group');
            assert.strictEqual(opts.method, 'DELETE');
        });

        test('throws on server error', async () => {
            fetchMock = mockFetchResponse(500, 'Internal Server Error');
            global.fetch = fetchMock;

            await assert.rejects(() => client.deleteGroup('bad-group'), {
                message: /failed \(500\)/,
            });
        });
    });

    describe('updateDesiredCount', () => {
        test('sends partial desired values', async () => {
            fetchMock = mockFetchResponse(200, undefined, 'text/plain');
            global.fetch = fetchMock;

            await client.updateDesiredCount('g1', { desiredCount: 5, maxDesired: 10 });

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/g1/desired');
            assert.strictEqual(opts.method, 'PUT');
            assert.deepStrictEqual(JSON.parse(opts.body), { desiredCount: 5, maxDesired: 10 });
        });
    });

    describe('updateScalingOptions', () => {
        test('sends partial scaling options', async () => {
            fetchMock = mockFetchResponse(200, undefined, 'text/plain');
            global.fetch = fetchMock;

            await client.updateScalingOptions('g1', { scaleUpThreshold: 0.8 });

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/g1/scaling-options');
            assert.deepStrictEqual(JSON.parse(opts.body), { scaleUpThreshold: 0.8 });
        });
    });

    describe('updateScalingActivities', () => {
        test('sends activity toggles', async () => {
            fetchMock = mockFetchResponse(200, undefined, 'text/plain');
            global.fetch = fetchMock;

            await client.updateScalingActivities('g1', { enableAutoScale: false, enableLaunch: true });

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/g1/scaling-activities');
            assert.deepStrictEqual(JSON.parse(opts.body), { enableAutoScale: false, enableLaunch: true });
        });
    });

    describe('getGroupReport', () => {
        test('returns report when found', async () => {
            const report = { groupName: 'g1', count: 3, desiredCount: 5 };
            fetchMock = mockFetchResponse(200, { groupReport: report });
            global.fetch = fetchMock;

            const result = await client.getGroupReport('g1');

            assert.deepStrictEqual(result, report);
        });

        test('returns null for 404', async () => {
            fetchMock = mockFetchResponse(404, 'Not Found');
            global.fetch = fetchMock;

            const result = await client.getGroupReport('nonexistent');

            assert.strictEqual(result, null);
        });
    });

    describe('getGroupAudit', () => {
        test('returns audit when found', async () => {
            const audit = {
                lastLauncherRun: '2024-01-01T00:00:00Z',
                lastAutoScalerRun: '2024-01-01T00:00:00Z',
                lastReconfigureRequest: '',
            };
            fetchMock = mockFetchResponse(200, { audit });
            global.fetch = fetchMock;

            const result = await client.getGroupAudit('g1');

            assert.deepStrictEqual(result, audit);
        });
    });

    describe('getScheduledScaling', () => {
        test('returns config when found', async () => {
            const config = { enabled: true, timezone: 'UTC', periods: [] };
            fetchMock = mockFetchResponse(200, { scheduledScaling: config });
            global.fetch = fetchMock;

            const result = await client.getScheduledScaling('g1');

            assert.deepStrictEqual(result, config);
        });

        test('returns null for 404', async () => {
            fetchMock = mockFetchResponse(404, 'Not Found');
            global.fetch = fetchMock;

            const result = await client.getScheduledScaling('g1');

            assert.strictEqual(result, null);
        });
    });

    describe('updateScheduledScaling', () => {
        test('sends PUT with scheduled scaling config', async () => {
            fetchMock = mockFetchResponse(200, undefined, 'text/plain');
            global.fetch = fetchMock;

            const config = {
                enabled: true,
                timezone: 'UTC',
                periods: [
                    {
                        name: 'weekend-scaledown',
                        dayOfWeek: [0, 6],
                        startHour: 0,
                        endHour: 0,
                        priority: 1,
                        scalingOptions: { minDesired: 3, scaleDownThreshold: 3, scaleUpThreshold: 2 },
                    },
                ],
            };
            await client.updateScheduledScaling('g1', config as ScheduledScalingConfig);

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/g1/scheduled-scaling');
            assert.strictEqual(opts.method, 'PUT');
            assert.deepStrictEqual(JSON.parse(opts.body), config);
        });
    });

    describe('URL encoding', () => {
        test('encodes group names with special characters', async () => {
            fetchMock = mockFetchResponse(200, { instanceGroup: { name: 'group/special' } });
            global.fetch = fetchMock;

            await client.getGroup('group/special');

            const [url] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups/group%2Fspecial');
        });
    });

    describe('base URL trailing slash', () => {
        test('strips trailing slashes from base URL', async () => {
            const c = new AutoscalerApiClient('http://localhost:3000///', 'token');
            fetchMock = mockFetchResponse(200, []);
            global.fetch = fetchMock;

            await c.listGroups();

            const [url] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups');
        });
    });

    describe('withOverrides', () => {
        test('returns same client when both are undefined', () => {
            const same = client.withOverrides(undefined, undefined);
            assert.strictEqual(same, client);
        });

        test('returns same client when both are empty', () => {
            const same = client.withOverrides('', '');
            assert.strictEqual(same, client);
        });

        test('returns new client with overridden URL', async () => {
            const overridden = client.withOverrides('http://other-host:4000', undefined);
            fetchMock = mockFetchResponse(200, { instanceGroups: [] });
            global.fetch = fetchMock;

            await overridden.listGroups();

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://other-host:4000/groups');
            assert.strictEqual(opts.headers.Authorization, 'Bearer test-token');
        });

        test('returns new client with overridden token', async () => {
            const overridden = client.withOverrides(undefined, 'other-token');
            fetchMock = mockFetchResponse(200, { instanceGroups: [] });
            global.fetch = fetchMock;

            await overridden.listGroups();

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://localhost:3000/groups');
            assert.strictEqual(opts.headers.Authorization, 'Bearer other-token');
        });

        test('returns new client with both overridden', async () => {
            const overridden = client.withOverrides('http://other:5000', 'new-token');
            fetchMock = mockFetchResponse(200, { instanceGroups: [] });
            global.fetch = fetchMock;

            await overridden.listGroups();

            const [url, opts] = fetchMock.mock.calls[0].arguments;
            assert.strictEqual(url, 'http://other:5000/groups');
            assert.strictEqual(opts.headers.Authorization, 'Bearer new-token');
        });
    });
});
