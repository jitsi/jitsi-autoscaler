/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { after, afterEach, before, describe, mock } from 'node:test';
import fs from 'fs';
import { ConfigFileAuthenticationDetailsProvider } from 'oci-common';
import { ResourceSearchClient } from 'oci-resourcesearch';

import OracleInstanceManager, {
    buildPlacementTargets,
    escapeOciQueryLiteral,
    selectPlacement,
    usableAvailabilityDomains,
} from '../oracle_instance_manager';
import { writeTempOciConfig } from './mock_oci_config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function initContext() {
    return {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };
}

describe('oracle placement selection', () => {
    describe('single AD with three FDs', () => {
        const ads = ['AD-1'];
        const fds = { 'AD-1': ['FD-1', 'FD-2', 'FD-3'] };

        test('retries cycle through every fault domain and wrap around', () => {
            const placements = [0, 1, 2, 3].map((retries) => selectPlacement(0, 0, retries, ads, fds));
            // initial FD index for index 0 / count 0 is (0 + 0 + 1) % 3 = FD-2
            assert.deepEqual(
                placements.map((p) => p.faultDomain),
                ['FD-2', 'FD-3', 'FD-1', 'FD-2'],
            );
            assert.ok(placements.every((p) => p.availabilityDomain === 'AD-1'));
        });

        test('consecutive instances in a batch are spread across fault domains', () => {
            const placements = [0, 1, 2].map((index) => selectPlacement(index, 0, 0, ads, fds));
            assert.deepEqual(
                placements.map((p) => p.faultDomain),
                ['FD-2', 'FD-3', 'FD-1'],
            );
        });

        test('max retries equals the total number of fault domains', () => {
            const manager = Object.create(OracleInstanceManager.prototype);
            assert.equal(manager.calcMaxRetries(fds), 3);
            assert.equal(buildPlacementTargets(ads, fds).length, 3);
        });
    });

    describe('three ADs with three FDs each', () => {
        const ads = ['AD-1', 'AD-2', 'AD-3'];
        const fds = {
            'AD-1': ['AD-1-FD-1', 'AD-1-FD-2', 'AD-1-FD-3'],
            'AD-2': ['AD-2-FD-1', 'AD-2-FD-2', 'AD-2-FD-3'],
            'AD-3': ['AD-3-FD-1', 'AD-3-FD-2', 'AD-3-FD-3'],
        };

        test('retries exhaust the fault domains of the selected AD before moving to the next AD', () => {
            const placements = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((retries) =>
                selectPlacement(0, 0, retries, ads, fds),
            );
            // initial placement for index 0 / count 0: AD index 1 (AD-2), FD index 1 (AD-2-FD-2)
            assert.deepEqual(
                placements.map((p) => p.faultDomain),
                [
                    'AD-2-FD-2',
                    'AD-2-FD-3',
                    'AD-3-FD-1',
                    'AD-3-FD-2',
                    'AD-3-FD-3',
                    'AD-1-FD-1',
                    'AD-1-FD-2',
                    'AD-1-FD-3',
                    'AD-2-FD-1',
                    'AD-2-FD-2',
                ],
            );
            assert.deepEqual(
                placements.map((p) => p.availabilityDomain),
                ['AD-2', 'AD-2', 'AD-3', 'AD-3', 'AD-3', 'AD-1', 'AD-1', 'AD-1', 'AD-2', 'AD-2'],
            );
        });

        test('the FD retry index is based on the fault domain count, not the AD count', () => {
            // with a single FD per AD every retry must move to the next AD
            const oneFd = { 'AD-1': ['AD-1-FD-1'], 'AD-2': ['AD-2-FD-1'], 'AD-3': ['AD-3-FD-1'] };
            const placements = [0, 1, 2, 3].map((retries) => selectPlacement(0, 0, retries, ads, oneFd));
            assert.deepEqual(
                placements.map((p) => p.availabilityDomain),
                ['AD-2', 'AD-3', 'AD-1', 'AD-2'],
            );
        });

        test('an AD without known fault domains is excluded from placement', () => {
            const partial = { 'AD-1': fds['AD-1'], 'AD-3': fds['AD-3'] };
            assert.deepEqual(usableAvailabilityDomains(ads, partial), ['AD-1', 'AD-3']);
            assert.equal(buildPlacementTargets(ads, partial).length, 6);
            for (let retries = 0; retries < 12; retries++) {
                const placement = selectPlacement(0, 0, retries, ads, partial);
                assert.notEqual(placement.availabilityDomain, 'AD-2');
            }
            assert.equal(selectPlacement(0, 0, 0, ads, { 'AD-2': [] }), undefined);
            assert.equal(selectPlacement(0, 0, 0, ads, {}), undefined);
        });
    });

    test('escapeOciQueryLiteral escapes backslashes and single quotes', () => {
        assert.equal(escapeOciQueryLiteral('plain-name'), 'plain-name');
        assert.equal(escapeOciQueryLiteral("it's"), "it\\'s");
        assert.equal(escapeOciQueryLiteral('a\\b'), 'a\\\\b');
        assert.equal(escapeOciQueryLiteral("x') || (freeformTags.key = 'y"), "x\\') || (freeformTags.key = \\'y");
    });
});

describe('OracleInstanceManager.launchInstances', () => {
    const group = { name: 'g', region: 'r1', compartmentId: 'c', instanceConfigurationId: 'ic' };
    const adNames = ['AD-1', 'AD-2', 'AD-3'];

    // bypass the constructor (it reads an OCI config file) and plug mocked, region-cached clients
    function buildManager({ listFaultDomains, launchInstanceConfiguration, listAvailabilityDomains }) {
        const manager = Object.create(OracleInstanceManager.prototype);
        manager.isDryRun = false;
        manager.requestTimeoutMs = 1000;
        manager.identityClientsByRegion = new Map([
            [
                'r1',
                {
                    listAvailabilityDomains:
                        listAvailabilityDomains || mock.fn(async () => ({ items: adNames.map((name) => ({ name })) })),
                    listFaultDomains,
                },
            ],
        ]);
        manager.computeManagementClientsByRegion = new Map([['r1', { launchInstanceConfiguration }]]);
        return manager;
    }

    const oneFaultDomainPerAD = () =>
        mock.fn(async ({ availabilityDomain }) => ({ items: [{ name: `${availabilityDomain}-FD-1` }] }));
    const launchedAD = (call) => call.arguments[0].instanceConfiguration.launchDetails.availabilityDomain;

    test('retries in the next AD when out of host capacity and skips ADs whose FD lookup failed', async () => {
        const listFaultDomains = mock.fn(async ({ availabilityDomain }) => {
            if (availabilityDomain === 'AD-2') {
                throw new Error('identity service unavailable');
            }
            return { items: [{ name: `${availabilityDomain}-FD-1` }] };
        });
        const launchInstanceConfiguration = mock.fn(async (request) => {
            if (launchInstanceConfiguration.mock.calls.length === 0) {
                throw new Error('Out of host capacity');
            }
            return { instance: { id: `ocid-${request.instanceConfiguration.launchDetails.availabilityDomain}` } };
        });
        const manager = buildManager({ listFaultDomains, launchInstanceConfiguration });
        const ctx = initContext();

        const result = await manager.launchInstances(ctx, group, 0, 1);

        // usable ADs are AD-1 and AD-3; index 0 / count 0 selects AD-3 first, the retry moves to AD-1
        assert.deepEqual(result, ['ocid-AD-1']);
        assert.deepEqual(launchInstanceConfiguration.mock.calls.map(launchedAD), ['AD-3', 'AD-1']);
        assert.equal(ctx.logger.error.mock.calls.length, 1, 'failed FD lookup logged');
        assert.ok(ctx.logger.warn.mock.calls.length >= 1, 'reduced AD set and capacity retry logged');
    });

    test('never rejects: an unexpected error in one launch does not lose sibling ids', async () => {
        const launchInstanceConfiguration = mock.fn(async (request) => {
            const availabilityDomain = request.instanceConfiguration.launchDetails.availabilityDomain;
            if (availabilityDomain === 'AD-1') {
                throw new TypeError("Cannot read properties of undefined (reading 'length')");
            }
            return { instance: { id: `ocid-${availabilityDomain}` } };
        });
        const manager = buildManager({ listFaultDomains: oneFaultDomainPerAD(), launchInstanceConfiguration });

        const result = await manager.launchInstances(initContext(), group, 0, 3);

        // indexes 0, 1, 2 select AD-2, AD-3, AD-1; the AD-1 launch fails with a non-capacity error
        assert.deepEqual(result, ['ocid-AD-2', 'ocid-AD-3', false]);
    });

    test('gives up after one retry per fault domain and resolves false', async () => {
        const launchInstanceConfiguration = mock.fn(async () => {
            throw new Error('Out of host capacity');
        });
        const manager = buildManager({ listFaultDomains: oneFaultDomainPerAD(), launchInstanceConfiguration });

        const result = await manager.launchInstances(initContext(), group, 0, 1);

        assert.deepEqual(result, [false]);
        // 3 fault domains in total: one initial attempt plus 3 retries
        assert.equal(launchInstanceConfiguration.mock.calls.length, 4);
        assert.deepEqual(launchInstanceConfiguration.mock.calls.map(launchedAD), ['AD-2', 'AD-3', 'AD-1', 'AD-2']);
        // every attempt is a distinct request and carries its own idempotency token
        const tokens = launchInstanceConfiguration.mock.calls.map((call) => call.arguments[0].opcRetryToken);
        for (const token of tokens) {
            assert.match(token, UUID_RE, 'opcRetryToken is a UUID');
        }
        assert.equal(new Set(tokens).size, 4, 'opcRetryToken is unique per attempt');
    });

    test('every launch request in a batch carries a unique opcRetryToken', async () => {
        const launchInstanceConfiguration = mock.fn(async (request) => ({
            instance: { id: `ocid-${request.instanceConfiguration.launchDetails.availabilityDomain}` },
        }));
        const manager = buildManager({ listFaultDomains: oneFaultDomainPerAD(), launchInstanceConfiguration });

        const result = await manager.launchInstances(initContext(), group, 0, 3);

        assert.deepEqual(result, ['ocid-AD-2', 'ocid-AD-3', 'ocid-AD-1']);
        const tokens = launchInstanceConfiguration.mock.calls.map((call) => call.arguments[0].opcRetryToken);
        assert.equal(tokens.length, 3);
        for (const token of tokens) {
            assert.match(token, UUID_RE, 'opcRetryToken is a UUID');
        }
        assert.equal(new Set(tokens).size, 3, 'opcRetryToken is unique per launch');
    });

    describe('request timeouts', () => {
        const never = () => mock.fn(() => new Promise(() => undefined));

        test('a launch that never responds resolves false within the request timeout and logs that the instance may exist', async () => {
            const launchInstanceConfiguration = never();
            const manager = buildManager({ listFaultDomains: oneFaultDomainPerAD(), launchInstanceConfiguration });
            manager.requestTimeoutMs = 20;
            const ctx = initContext();

            const started = Date.now();
            const result = await manager.launchInstances(ctx, group, 0, 1);
            const elapsed = Date.now() - started;

            assert.deepEqual(result, [false]);
            assert.ok(elapsed < 1000, `settled in ${elapsed}ms`);
            // a timeout is not a capacity error: no retry in another domain, which would create a second instance
            assert.equal(launchInstanceConfiguration.mock.calls.length, 1);
            const errors = ctx.logger.error.mock.calls.map((call) => call.arguments);
            assert.equal(errors.length, 1);
            const [message, meta] = errors[0];
            assert.match(message, /timed out after 20ms/);
            assert.match(message, /may have been created and is untracked until its sidecar reports/);
            assert.match(message, /group g in region r1/);
            assert.equal(meta.err.name, 'TimeoutError');
            assert.match(meta.err.message, /launchInstanceConfiguration .* group g in region r1 timed out after 20ms/);
        });

        test('a hung availability domain lookup resolves quantity x false within the request timeout', async () => {
            const launchInstanceConfiguration = mock.fn();
            const manager = buildManager({
                listAvailabilityDomains: never(),
                listFaultDomains: oneFaultDomainPerAD(),
                launchInstanceConfiguration,
            });
            manager.requestTimeoutMs = 20;
            const ctx = initContext();

            const started = Date.now();
            const result = await manager.launchInstances(ctx, group, 0, 2);
            const elapsed = Date.now() - started;

            assert.deepEqual(result, [false, false]);
            assert.ok(elapsed < 1000, `settled in ${elapsed}ms`);
            assert.equal(launchInstanceConfiguration.mock.calls.length, 0);
            const [message, meta] = ctx.logger.error.mock.calls[0].arguments;
            assert.match(message, /Failed listing availability\/fault domains for group g/);
            assert.equal(meta.err.name, 'TimeoutError');
            assert.match(meta.err.message, /listAvailabilityDomains for group g in region r1 timed out after 20ms/);
        });

        test('a hung fault domain lookup excludes only that AD within the request timeout', async () => {
            const listFaultDomains = mock.fn(({ availabilityDomain }) => {
                if (availabilityDomain === 'AD-2') {
                    return new Promise(() => undefined);
                }
                return Promise.resolve({ items: [{ name: `${availabilityDomain}-FD-1` }] });
            });
            const launchInstanceConfiguration = mock.fn(async (request) => ({
                instance: { id: `ocid-${request.instanceConfiguration.launchDetails.availabilityDomain}` },
            }));
            const manager = buildManager({ listFaultDomains, launchInstanceConfiguration });
            manager.requestTimeoutMs = 20;
            const ctx = initContext();

            const started = Date.now();
            const result = await manager.launchInstances(ctx, group, 0, 1);
            const elapsed = Date.now() - started;

            assert.ok(elapsed < 1000, `settled in ${elapsed}ms`);
            // usable ADs are AD-1 and AD-3
            assert.deepEqual(result, ['ocid-AD-3']);
            const [message, meta] = ctx.logger.error.mock.calls[0].arguments;
            assert.match(message, /Failed listing fault domains for availability domain AD-2/);
            assert.equal(meta.err.name, 'TimeoutError');
            assert.match(meta.err.message, /listFaultDomains \(AD-2\) for group g in region r1 timed out after 20ms/);
        });

        test('the timeout timer is cleared after a fast response so it cannot keep the process alive', async () => {
            const launchInstanceConfiguration = mock.fn(async (request) => ({
                instance: { id: `ocid-${request.instanceConfiguration.launchDetails.availabilityDomain}` },
            }));
            const manager = buildManager({ listFaultDomains: oneFaultDomainPerAD(), launchInstanceConfiguration });
            // a distinctive delay so timers armed by the test runner itself can be told apart
            manager.requestTimeoutMs = 4321;
            const setTimeoutSpy = mock.method(globalThis, 'setTimeout');
            const clearTimeoutSpy = mock.method(globalThis, 'clearTimeout');
            try {
                const result = await manager.launchInstances(initContext(), group, 0, 1);
                assert.deepEqual(result, ['ocid-AD-2']);

                const armed = setTimeoutSpy.mock.calls.filter((call) => call.arguments[1] === 4321);
                // listAvailabilityDomains + 3 x listFaultDomains + launchInstanceConfiguration
                assert.equal(armed.length, 5, 'one timer per SDK call');
                const cleared = new Set(clearTimeoutSpy.mock.calls.map((call) => call.arguments[0]));
                for (const call of armed) {
                    assert.ok(cleared.has(call.result), 'timer cleared once the SDK call settled');
                    assert.equal(call.result.hasRef(), true, 'timer is a ref-ed timer while armed');
                }
            } finally {
                setTimeoutSpy.mock.restore();
                clearTimeoutSpy.mock.restore();
            }
        });

        test('withTimeout passes through the settled value or the original rejection', async () => {
            const manager = Object.create(OracleInstanceManager.prototype);
            assert.equal(await manager.withTimeout(Promise.resolve(42), 1000, 'op'), 42);
            await assert.rejects(manager.withTimeout(Promise.reject(new Error('boom')), 1000, 'op'), {
                name: 'Error',
                message: 'boom',
            });
            await assert.rejects(manager.withTimeout(new Promise(() => undefined), 5, 'op for group g in region r'), {
                name: 'TimeoutError',
                message: 'op for group g in region r timed out after 5ms',
            });
        });
    });

    test('resolves quantity x false when no AD has known fault domains', async () => {
        const launchInstanceConfiguration = mock.fn();
        const listFaultDomains = mock.fn(async () => {
            throw new Error('nope');
        });
        const manager = buildManager({ listFaultDomains, launchInstanceConfiguration });
        const ctx = initContext();

        const result = await manager.launchInstances(ctx, group, 0, 2);

        assert.deepEqual(result, [false, false]);
        assert.equal(launchInstanceConfiguration.mock.calls.length, 0);
        assert.ok(ctx.logger.error.mock.calls.length >= 1);
    });

    test('resolves quantity x false when listing availability domains fails', async () => {
        const launchInstanceConfiguration = mock.fn();
        const manager = buildManager({
            listAvailabilityDomains: mock.fn(async () => {
                throw new Error('timeout');
            }),
            listFaultDomains: oneFaultDomainPerAD(),
            launchInstanceConfiguration,
        });

        const result = await manager.launchInstances(initContext(), group, 0, 2);

        assert.deepEqual(result, [false, false]);
        assert.equal(launchInstanceConfiguration.mock.calls.length, 0);
    });

    test('dry run resolves true without calling the compute API', async () => {
        const launchInstanceConfiguration = mock.fn();
        const manager = buildManager({ listFaultDomains: oneFaultDomainPerAD(), launchInstanceConfiguration });
        manager.isDryRun = true;

        const result = await manager.launchInstances(initContext(), group, 0, 2);

        assert.deepEqual(result, [true, true]);
        assert.equal(launchInstanceConfiguration.mock.calls.length, 0);
    });
});

describe('OracleInstanceManager.getInstances', () => {
    test('escapes the group name in the search query', () => {
        const query = `query instance resources where (freeformTags.key = 'group' && freeformTags.value = '${escapeOciQueryLiteral(
            "grp'--",
        )}')`;
        assert.equal(
            query,
            "query instance resources where (freeformTags.key = 'group' && freeformTags.value = 'grp\\'--')",
        );
    });
});

describe('OracleInstanceManager.getInstances pagination', () => {
    const group = { name: 'g', region: 'us-phoenix-1', compartmentId: 'c', instanceConfigurationId: 'ic' };
    const retryStrategy = { maxTimeInSeconds: 1, maxDelayInSeconds: 1, retryableStatusCodes: [429] };
    const summary = (id) => ({ identifier: id, displayName: `name-${id}`, lifecycleState: 'RUNNING' });
    const pageTokens = (search) => search.mock.calls.map((call) => call.arguments[0].page);

    let ociConfig;
    let manager;

    before(() => {
        // getInstances builds a fresh ResourceSearchClient per call from this.provider, so the only
        // seam is the client prototype. The SDK parses the private key when the client is built,
        // hence a real (throwaway) key in a temp OCI config rather than a fake provider object.
        ociConfig = writeTempOciConfig();
        manager = Object.create(OracleInstanceManager.prototype);
        manager.provider = new ConfigFileAuthenticationDetailsProvider(ociConfig.configPath, 'DEFAULT');
        manager.requestTimeoutMs = 1000;
        manager.isDryRun = false;
    });

    after(() => {
        fs.rmSync(ociConfig.dir, { recursive: true, force: true });
    });

    afterEach(() => {
        mock.restoreAll();
    });

    test('follows opcNextPage and returns the items of every page', async () => {
        const pages = {
            first: { opcNextPage: 'page-2-token', resourceSummaryCollection: { items: [summary('a'), summary('b')] } },
            second: { resourceSummaryCollection: { items: [summary('c')] } },
        };
        const endpoints = [];
        const search = mock.method(ResourceSearchClient.prototype, 'searchResources', async function (request) {
            endpoints.push(this.endpoint);
            return request.page ? pages.second : pages.first;
        });
        const ctx = initContext();

        const result = await manager.getInstances(ctx, group, retryStrategy);

        assert.deepStrictEqual(result, [
            { instanceId: 'a', displayName: 'name-a', cloudStatus: 'RUNNING' },
            { instanceId: 'b', displayName: 'name-b', cloudStatus: 'RUNNING' },
            { instanceId: 'c', displayName: 'name-c', cloudStatus: 'RUNNING' },
        ]);
        assert.equal(search.mock.calls.length, 2);
        // the first request carries no page token, the second carries the token of the first response
        assert.deepStrictEqual(pageTokens(search), [undefined, 'page-2-token']);
        for (const call of search.mock.calls) {
            const request = call.arguments[0];
            assert.equal(request.limit, 1000, 'maximum page size requested');
            assert.equal(request.searchDetails.type, 'Structured');
            assert.ok(request.searchDetails.query.includes("freeformTags.value = 'g'"));
        }
        // the client is scoped to the region of the group
        assert.ok(
            endpoints.every((endpoint) => endpoint.includes('us-phoenix-1')),
            `endpoints ${endpoints}`,
        );
        assert.equal(ctx.logger.warn.mock.calls.length, 0);
    });

    test('stops after the page limit with a warning when the API keeps returning a next page token', async () => {
        const search = mock.method(ResourceSearchClient.prototype, 'searchResources', async () => ({
            opcNextPage: 'again',
            resourceSummaryCollection: { items: [summary('x')] },
        }));
        const ctx = initContext();

        const result = await manager.getInstances(ctx, group, retryStrategy);

        // OCI_SEARCH_MAX_PAGES
        assert.equal(search.mock.calls.length, 100);
        assert.equal(result.length, 100, 'items of every fetched page are still returned');
        assert.deepStrictEqual(pageTokens(search).slice(0, 2), [undefined, 'again']);
        assert.equal(ctx.logger.warn.mock.calls.length, 1);
        assert.match(
            ctx.logger.warn.mock.calls[0].arguments[0],
            /\[oracle\] Stopped paging instance search for group g after 100 pages, results may be incomplete/,
        );
    });

    test('treats a response without a resource summary collection as an empty page', async () => {
        const search = mock.method(ResourceSearchClient.prototype, 'searchResources', async () => ({}));

        const result = await manager.getInstances(initContext(), group, retryStrategy);

        assert.deepStrictEqual(result, []);
        assert.equal(search.mock.calls.length, 1);
    });

    test('a failing search rejects instead of returning a partial list', async () => {
        mock.method(ResourceSearchClient.prototype, 'searchResources', async (request) => {
            if (request.page) {
                throw new Error('429 TooManyRequests');
            }
            return { opcNextPage: 'next', resourceSummaryCollection: { items: [summary('a')] } };
        });

        await assert.rejects(manager.getInstances(initContext(), group, retryStrategy), /429 TooManyRequests/);
    });

    test('a search that never responds rejects with a TimeoutError naming the group and region', async () => {
        mock.method(ResourceSearchClient.prototype, 'searchResources', () => new Promise(() => undefined));
        manager.requestTimeoutMs = 20;
        // no SDK-side retry window, so the bound is exactly the request timeout
        const noRetry = { maxTimeInSeconds: 0, maxDelayInSeconds: 1, retryableStatusCodes: [429] };

        const started = Date.now();
        try {
            await assert.rejects(manager.getInstances(initContext(), group, noRetry), {
                name: 'TimeoutError',
                message: 'searchResources (page 1) for group g in region us-phoenix-1 timed out after 20ms',
            });
        } finally {
            manager.requestTimeoutMs = 1000;
        }
        assert.ok(Date.now() - started < 1000);
    });

    test('the search timeout budget covers the SDK retry window plus one request timeout', async () => {
        mock.method(ResourceSearchClient.prototype, 'searchResources', async () => ({}));
        const withTimeout = mock.method(manager, 'withTimeout');
        try {
            await manager.getInstances(initContext(), group, retryStrategy);
        } finally {
            withTimeout.mock.restore();
        }
        assert.equal(withTimeout.mock.calls.length, 1);
        // maxTimeInSeconds 1 -> 1000ms, plus requestTimeoutMs 1000
        assert.equal(withTimeout.mock.calls[0].arguments[1], 2000);
    });
});
