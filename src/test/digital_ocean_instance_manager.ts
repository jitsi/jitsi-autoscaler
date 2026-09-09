/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { beforeEach, describe, mock } from 'node:test';

import DigitalOceanInstanceManager from '../digital_ocean_instance_manager';

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

describe('DigitalOceanInstanceManager', () => {
    const group = { name: 'grp', type: 'jibri', region: 'nyc3', instanceConfigurationId: 'x' };

    const pages = {
        1: {
            droplets: [
                { id: 1, name: 'grp-a', status: 'active' },
                { id: 2, name: 'grp-b', status: 'new' },
            ],
            links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?page=2&per_page=200', last: '...' } },
            meta: { total: 5 },
        },
        2: {
            droplets: [
                { id: 3, name: 'grp-c', status: 'off' },
                { id: 4, name: 'grp-d', status: 'archive' },
                { id: 5, name: 'grp-e', status: 'weird' },
            ],
            links: { pages: { prev: 'https://api.digitalocean.com/v2/droplets?page=1&per_page=200', first: '...' } },
            meta: { total: 5 },
        },
    };

    let listDroplets;
    let manager;

    beforeEach(() => {
        listDroplets = mock.fn(async ({ page }) => ({ data: pages[page], status: 200, headers: {} }));
        manager = new DigitalOceanInstanceManager({
            isDryRun: true,
            digitalOceanAPIToken: 'token',
            digitalOceanConfigurationFilePath: '',
            digitalOceanConfig: {},
            doClient: { droplet: { listDroplets } },
        });
    });

    test('getInstances follows pagination links until the last page', async () => {
        const result = await manager.getInstances(initContext(), group, {});

        assert.equal(listDroplets.mock.calls.length, 2, 'two pages fetched');
        assert.deepEqual(
            listDroplets.mock.calls.map((call) => call.arguments[0]),
            [
                { page: 1, per_page: 200, tag_name: 'group:grp' },
                { page: 2, per_page: 200, tag_name: 'group:grp' },
            ],
        );
        assert.deepEqual(
            result.map((i) => i.instanceId),
            ['1', '2', '3', '4', '5'],
        );
    });

    test('getInstances maps droplet statuses without reporting stopped droplets as terminated', async () => {
        const result = await manager.getInstances(initContext(), group, {});

        assert.deepEqual(result, [
            { instanceId: '1', displayName: 'grp-a', cloudStatus: 'RUNNING' },
            { instanceId: '2', displayName: 'grp-b', cloudStatus: 'PROVISIONING' },
            { instanceId: '3', displayName: 'grp-c', cloudStatus: 'STOPPED' },
            { instanceId: '4', displayName: 'grp-d', cloudStatus: 'ARCHIVED' },
            { instanceId: '5', displayName: 'grp-e', cloudStatus: 'WEIRD' },
        ]);
        assert.ok(result.every((i) => i.cloudStatus.toUpperCase() !== 'TERMINATED'));
    });

    test('getInstances handles a single page without links', async () => {
        listDroplets.mock.mockImplementation(async () => ({
            data: { droplets: [{ id: 9, name: 'grp-z', status: 'active' }] },
            status: 200,
            headers: {},
        }));

        const result = await manager.getInstances(initContext(), group, {});

        assert.equal(listDroplets.mock.calls.length, 1);
        assert.deepEqual(result, [{ instanceId: '9', displayName: 'grp-z', cloudStatus: 'RUNNING' }]);
    });

    test('mapStatus', () => {
        assert.equal(DigitalOceanInstanceManager.mapStatus('new'), 'PROVISIONING');
        assert.equal(DigitalOceanInstanceManager.mapStatus('active'), 'RUNNING');
        assert.equal(DigitalOceanInstanceManager.mapStatus('off'), 'STOPPED');
        assert.equal(DigitalOceanInstanceManager.mapStatus('archive'), 'ARCHIVED');
        assert.equal(DigitalOceanInstanceManager.mapStatus('something'), 'SOMETHING');
        assert.equal(DigitalOceanInstanceManager.mapStatus(''), 'UNKNOWN');
        assert.equal(DigitalOceanInstanceManager.mapStatus(undefined), 'UNKNOWN');
    });

    test('default construction path creates an API client with the request timeout', () => {
        const defaultManager = new DigitalOceanInstanceManager({
            isDryRun: true,
            digitalOceanAPIToken: 'token',
            digitalOceanConfigurationFilePath: '',
            digitalOceanConfig: {},
            cloudProviderRequestTimeoutMs: 4321,
        });
        assert.equal(defaultManager.doClient._options.requestTimeoutInMs, 4321);

        const implicitTimeout = new DigitalOceanInstanceManager({
            isDryRun: true,
            digitalOceanAPIToken: 'token',
            digitalOceanConfigurationFilePath: '',
            digitalOceanConfig: {},
        });
        assert.equal(implicitTimeout.doClient._options.requestTimeoutInMs, 30000);
    });

    test('launchInstance fails cleanly when the type is not configured', async () => {
        const ctx = initContext();
        manager.isDryRun = false;
        const result = await manager.launchInstance(ctx, 0, group);
        assert.equal(result, false);
        assert.equal(ctx.logger.error.mock.calls.length, 1);
    });
});
