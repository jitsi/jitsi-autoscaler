/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

// config.ts reads its env at import time, so the environment has to be complete before the require.
const groupConfigFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autoscaler-config-')), 'groups.json');
fs.writeFileSync(groupConfigFile, JSON.stringify({ groupEntries: [] }));

Object.assign(process.env, {
    ASAP_PUB_KEY_BASE_URL: 'https://example.invalid/server',
    ASAP_JWT_AUD: 'jitsi-autoscaler',
    ASAP_JWT_ACCEPTED_HOOK_ISS: 'jitsi-autoscaler-sidecar',
    GROUP_CONFIG_FILE: groupConfigFile,
    DEFAULT_INSTANCE_CONFIGURATION_ID: 'ocid1.instanceconfiguration.oc1.phx.test',
    DEFAULT_COMPARTMENT_ID: 'ocid1.compartment.oc1..test',
    OCI_CONFIGURATION_FILE_PATH: '/config/oci.config',
    OCI_CONFIGURATION_PROFILE: 'DEFAULT',
    REDIS_PASSWORD: 'sup3r-s3cret-redis-password',
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: config, redactedConfig } = require('../config');

describe('config redaction', () => {
    // The startup config dump goes to the log store, so credentials must not be in it.
    test('the redis password is masked', () => {
        const redacted = redactedConfig();

        assert.strictEqual(config.RedisPassword, 'sup3r-s3cret-redis-password');
        assert.strictEqual(redacted.RedisPassword, '<redacted>');
        assert.ok(
            !JSON.stringify(redacted).includes('sup3r-s3cret-redis-password'),
            'the password must not appear anywhere in the serialized config',
        );
    });

    test('an unset secret stays empty rather than looking configured', () => {
        // DIGITALOCEAN_API_TOKEN is not set above, so it keeps its '' default.
        assert.strictEqual(redactedConfig().DigitalOceanAPIToken, '');
    });

    test('non-secret values are left alone', () => {
        const redacted = redactedConfig();

        assert.strictEqual(redacted.AsapJwtAcceptedAud, config.AsapJwtAcceptedAud);
        assert.strictEqual(redacted.RedisHost, config.RedisHost);
        assert.strictEqual(redacted.HTTPServerPort, config.HTTPServerPort);
    });

    test('redaction does not mutate the config the app runs on', () => {
        redactedConfig();

        assert.strictEqual(config.RedisPassword, 'sup3r-s3cret-redis-password');
    });
});
