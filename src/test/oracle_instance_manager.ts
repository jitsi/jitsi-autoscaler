/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { describe, mock } from 'node:test';

import OracleInstanceManager, {
    buildPlacementTargets,
    escapeOciQueryLiteral,
    selectPlacement,
    usableAvailabilityDomains,
} from '../oracle_instance_manager';

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
