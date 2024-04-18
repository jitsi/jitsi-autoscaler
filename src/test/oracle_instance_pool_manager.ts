/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import core = require('oci-core');

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import OracleInstancePoolManager from '../oracle_instance_pool_manager';

function log(level, message, data) {
    console.log(`${new Date().toISOString()} ${level}: ${message}`);
    if (data) {
        console.log(JSON.stringify(data, null, 2));
    }
}

const group = {
    name: 'group',
    provider: 'oraclepool',
    region: 'testregion',
    compartmentId: 'testcpt',
    instanceConfigurationId: 'testpoolid',
};

describe('InstancePoolManager', () => {
    const manager = new OracleInstancePoolManager({
        isDryRun: false,
        ociConfigurationFilePath: __dirname + '/test_oracle_config',
        ociConfigurationProfile: 'TEST',
    });

    const mockWaiters = {
        forInstancePool: mock.fn((request, _) => {
            return {
                instancePool: <core.models.InstancePool>{
                    id: request.instancePoolId,
                    name: group.name,
                    compartmentId: group.compartmentId,
                    instanceConfigurationId: 'testid',
                    size: 2,
                },
            };
        }),
        forDetachInstancePoolInstance: mock.fn((request) => {
            return <core.responses.DetachInstancePoolInstanceResponse>{
                instancePoolInstance: request.detachInstancePoolInstanceDetails,
                workRequest: { id: 'testworkrequestid' },
            };
        }),
    };

    const mockComputeManagementClient = {
        createWaiters: mock.fn(() => {
            return mockWaiters;
        }),
        getInstancePool: mock.fn((request) => {
            return {
                instancePool: <core.models.InstancePool>{
                    id: request.instancePoolId,
                    name: group.name,
                    compartmentId: group.compartmentId,
                    instanceConfigurationId: 'testid',
                    size: 2,
                },
            };
        }),
        listInstancePoolInstances: mock.fn(() => {
            return { items: [{ id: 'testinstanceid-1' }, { id: 'testinstanceid-2' }] };
        }),
        updateInstancePool: mock.fn((request) => {
            return <core.models.InstancePool>{
                id: request.instancePoolId,
                name: group.name,
                compartmentId: group.compartmentId,
                instanceConfigurationId: 'testid',
                size: request.size,
            };
        }),
    };

    manager.setComputeManagementClient(mockComputeManagementClient);

    const context = {
        logger: {
            debug: mock.fn((message, data) => {
                log('DEBUG', message, data);
            }),
            info: mock.fn((message, data) => {
                log('INFO', message, data);
            }),
            warn: mock.fn((message, data) => {
                log('WARN', message, data);
            }),
            error: mock.fn((message, data) => {
                log('ERROR', message, data);
            }),
        },
    };

    afterEach(() => {
        mock.restoreAll();
    });

    describe('getInstances', () => {
        // This is a test for the getInstances method
        test('will list instances in a group', async () => {
            console.log('Starting getInstances test');
            const instances = await manager.getInstances(context, group, {
                maxAttempts: 1,
                maxTimeInSeconds: 60,
                maxDelayInSeconds: 30,
                retryableStatusCodes: [404, 429],
            });
            log('TEST', 'ended getInstances test');
            assert.ok(instances);
            log('TEST', 'found instances', instances);
        });
    });

    describe('launchInstances', () => {
        // This is a test for the launchInstances method
        test('will launch instances in a group', async () => {
            console.log('Starting launchInstances test');
            mockWaiters.forInstancePool.mock.mockImplementationOnce((_) => {
                return {
                    instancePool: <core.models.InstancePool>{
                        id: group.instanceConfigurationId,
                        name: group.name,
                        compartmentId: group.compartmentId,
                        instanceConfigurationId: 'testid',
                        size: 3,
                    },
                };
            });
            mockComputeManagementClient.listInstancePoolInstances.mock.mockImplementationOnce((_) => {
                return { items: [{ id: 'testinstanceid-1' }, { id: 'testinstanceid-2' }, { id: 'new-instance-id' }] };
            }, 2);
            const instances = await manager.launchInstances(context, group, 2, 1);
            console.log(mockComputeManagementClient.updateInstancePool.mock.callCount());
            assert.equal(mockComputeManagementClient.updateInstancePool.mock.callCount(), 1);
            assert.ok(instances);
            assert.equal(instances[0], 'new-instance-id');
            assert.equal(instances.length, 1);
            log('TEST', 'ended launchInstances test');
            log('TEST', 'launched instances', instances);
        });
    });
});
