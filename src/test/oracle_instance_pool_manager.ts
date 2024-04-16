/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import OracleInstancePoolManager from '../oracle_instance_pool_manager';

function log(level, message, data) {
    console.log(`${Date.now()} ${level}: ${message}`);
    console.log(data);
}

describe('InstancePoolManager', () => {
    const manager = new OracleInstancePoolManager({
        isDryRun: true,
        ociConfigurationFilePath: process.env.OCI_CONFIGURATION_FILE_PATH,
        ociConfigurationProfile: process.env.OCI_CONFIGURATION_PROFILE,
    });
    const context = {
        logger: {
            debug: mock.fn(log.bind('debug')),
            info: mock.fn(log.bind('info')),
            error: mock.fn(log.bind('error')),
        },
    };

    afterEach(() => {
        mock.restoreAll();
    });

    describe('getInstances', () => {
        // This is a test for the getInstances method
        test('will call the correct endpoint', async () => {
            console.log('Starting getInstances test');
            const instances = await manager.getInstances(
                context,
                {
                    name: 'group',
                    region: process.env.REGION,
                    compartmentId: process.env.COMPARTMENT_OCID,
                    instanceConfigurationId: process.env.INSTANCE_POOL_ID,
                },
                { maxAttempts: 1, maxTimeInSeconds: 60, maxDelayInSeconds: 30, retryableStatusCodes: [404, 429] },
            );
            console.log('ended getInstances test');
            assert.ok(instances);
            console.log(instances);
        });
    });
});
