/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { after, before, describe } from 'node:test';
import fs from 'fs';
import path from 'path';

import { CloudInstanceManagerSelector } from '../cloud_instance_manager_selector';
import OracleInstanceManager from '../oracle_instance_manager';
import DigitalOceanInstanceManager from '../digital_ocean_instance_manager';
import CustomInstanceManager from '../custom_instance_manager';
import NomadInstanceManager from '../nomad_instance_manager';
import { DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS } from '../cloud_instance_manager';
import { writeTempOciConfig } from './mock_oci_config';

const ALL_CLOUDS = ['oracle', 'digitalocean', 'nomad', 'custom'];

describe('CloudInstanceManagerSelector', () => {
    let ociConfig;
    let doConfigPath;

    before(() => {
        // the oracle and digitalocean managers read their config files in the constructor
        ociConfig = writeTempOciConfig();
        doConfigPath = path.join(ociConfig.dir, 'digitalocean.json');
        fs.writeFileSync(
            doConfigPath,
            JSON.stringify({ 'do-config': { size: 's-1vcpu-1gb', image: 'ubuntu-22-04-x64' } }),
        );
    });

    after(() => {
        fs.rmSync(ociConfig.dir, { recursive: true, force: true });
    });

    function buildOptions(overrides = {}) {
        return {
            cloudProviders: [],
            isDryRun: true,
            ociConfigurationFilePath: ociConfig.configPath,
            ociConfigurationProfile: 'DEFAULT',
            digitalOceanAPIToken: 'do-token',
            digitalOceanConfigurationFilePath: doConfigPath,
            customConfigurationLaunchScriptPath: '/opt/autoscaler/launch.sh',
            customConfigurationLaunchScriptTimeoutMs: 4000,
            customConfigurationListScriptPath: '/opt/autoscaler/list.sh',
            ...overrides,
        };
    }

    test('returns the manager matching each configured cloud name', () => {
        const selector = new CloudInstanceManagerSelector(buildOptions({ cloudProviders: ALL_CLOUDS }));

        assert.ok(selector.selectInstanceManager('oracle') instanceof OracleInstanceManager);
        assert.ok(selector.selectInstanceManager('digitalocean') instanceof DigitalOceanInstanceManager);
        assert.ok(selector.selectInstanceManager('nomad') instanceof NomadInstanceManager);
        assert.ok(selector.selectInstanceManager('custom') instanceof CustomInstanceManager);
        // managers are built once and reused
        assert.strictEqual(selector.selectInstanceManager('oracle'), selector.selectInstanceManager('oracle'));
    });

    test('returns null for an unknown cloud name', () => {
        const selector = new CloudInstanceManagerSelector(buildOptions({ cloudProviders: ALL_CLOUDS }));

        assert.strictEqual(selector.selectInstanceManager('aws'), null);
        assert.strictEqual(selector.selectInstanceManager('Oracle'), null, 'cloud names are case sensitive');
        assert.strictEqual(selector.selectInstanceManager(''), null);
    });

    test('returns no manager for a known cloud that is not in CLOUD_PROVIDERS', () => {
        const selector = new CloudInstanceManagerSelector(buildOptions({ cloudProviders: ['custom'] }));

        assert.ok(selector.selectInstanceManager('custom') instanceof CustomInstanceManager);
        // callers (CloudManager) only check for a falsy result, so either null or undefined is acceptable
        assert.equal(selector.selectInstanceManager('oracle'), undefined);
        assert.equal(selector.selectInstanceManager('digitalocean'), undefined);
        assert.equal(selector.selectInstanceManager('nomad'), undefined);
    });

    test('an empty CLOUD_PROVIDERS list yields no managers at all', () => {
        const selector = new CloudInstanceManagerSelector(buildOptions({ cloudProviders: [] }));

        for (const cloud of ALL_CLOUDS) {
            assert.equal(selector.selectInstanceManager(cloud), undefined, cloud);
        }
    });

    test('does not construct managers for clouds outside CLOUD_PROVIDERS', () => {
        // the oracle and digitalocean constructors throw on missing config files, so building the
        // selector proves they were skipped
        const selector = new CloudInstanceManagerSelector(
            buildOptions({
                cloudProviders: ['custom', 'nomad'],
                ociConfigurationFilePath: path.join(ociConfig.dir, 'does-not-exist'),
                digitalOceanConfigurationFilePath: path.join(ociConfig.dir, 'does-not-exist.json'),
            }),
        );

        assert.ok(selector.selectInstanceManager('custom') instanceof CustomInstanceManager);
        assert.ok(selector.selectInstanceManager('nomad') instanceof NomadInstanceManager);
        assert.equal(selector.selectInstanceManager('oracle'), undefined);
        assert.equal(selector.selectInstanceManager('digitalocean'), undefined);
    });

    test('propagates the cloud provider request timeout to the managers', () => {
        const selector = new CloudInstanceManagerSelector(
            buildOptions({ cloudProviders: ['oracle', 'nomad'], cloudProviderRequestTimeoutMs: 4321 }),
        );

        assert.equal(selector.selectInstanceManager('oracle').requestTimeoutMs, 4321);
        assert.equal(selector.selectInstanceManager('nomad').nomadClient.requestTimeoutMs, 4321);
    });

    test('defaults the cloud provider request timeout when not configured', () => {
        const selector = new CloudInstanceManagerSelector(buildOptions({ cloudProviders: ['oracle', 'nomad'] }));

        assert.equal(
            selector.selectInstanceManager('oracle').requestTimeoutMs,
            DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS,
        );
        assert.equal(
            selector.selectInstanceManager('nomad').nomadClient.requestTimeoutMs,
            DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS,
        );
    });

    test('passes the dry run flag and the custom script configuration through', () => {
        const selector = new CloudInstanceManagerSelector(
            buildOptions({ cloudProviders: ['custom', 'nomad', 'oracle'], isDryRun: false }),
        );

        const custom = selector.selectInstanceManager('custom');
        assert.equal(custom.isDryRun, false);
        assert.equal(custom.customConfigurationLaunchScriptPath, '/opt/autoscaler/launch.sh');
        assert.equal(custom.customConfigurationLaunchScriptTimeoutMs, 4000);
        assert.equal(custom.customConfigurationListScriptPath, '/opt/autoscaler/list.sh');
        assert.equal(selector.selectInstanceManager('nomad').isDryRun, false);
        assert.equal(selector.selectInstanceManager('oracle').isDryRun, false);
    });

    test('an unset list script leaves the custom manager without one', () => {
        const selector = new CloudInstanceManagerSelector(
            buildOptions({ cloudProviders: ['custom'], customConfigurationListScriptPath: undefined }),
        );

        assert.equal(selector.selectInstanceManager('custom').customConfigurationListScriptPath, '');
    });
});
