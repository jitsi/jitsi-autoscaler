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
    enableAutoScale: true,
    enableLaunch: true,
    scalingOptions: {
        minDesired: 1,
        maxDesired: 3,
        desiredCount: 2,
        scaleUpQuantity: 1,
        scaleDownQuantity: 1,
        scaleUpThreshold: 0.8,
        scaleDownThreshold: 0.3,
        scalePeriod: 60,
        scaleUpPeriodsCount: 2,
        scaleDownPeriodsCount: 2,
    },
};

const instancePool = <core.models.InstancePool>{
    id: group.instanceConfigurationId,
    name: group.name,
    compartmentId: group.compartmentId,
    instanceConfigurationId: 'testid',
    size: 2,
};

const instancePoolInstances = [{ id: 'testinstanceid-1' }, { id: 'testinstanceid-2' }];
const currentInventoryInstances = instancePoolInstances.map((instance) => {
    return { instanceId: instance.id };
});

describe('InstancePoolManager', () => {
    const mockInstanceTracker = {
        trimCurrent: mock.fn(() => Promise.resolve(currentInventoryInstances)),
    };

    const manager = new OracleInstancePoolManager({
        isDryRun: false,
        instanceTracker: mockInstanceTracker,
        ociConfigurationFilePath: __dirname + '/test_oracle_config',
        ociConfigurationProfile: 'TEST',
    });

    const mockWaiters = {
        forInstancePool: mock.fn(() => {
            return {
                instancePool,
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
        getInstancePool: mock.fn((_) => {
            return {
                instancePool,
            };
        }),
        listInstancePoolInstances: mock.fn(() => {
            return { items: instancePoolInstances };
        }),
        updateInstancePool: mock.fn((request) => {
            return <core.responses.UpdateInstancePoolResponse>{
                instancePool: <core.models.InstancePool>{
                    ...instancePool,
                    size: request.updateInstancePoolDetails.size,
                },
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
        mockComputeManagementClient.createWaiters.mock.resetCalls();
        mockComputeManagementClient.getInstancePool.mock.resetCalls();
        mockComputeManagementClient.listInstancePoolInstances.mock.resetCalls();
        mockComputeManagementClient.updateInstancePool.mock.resetCalls();
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
            assert.ok(instances, 'some instances should be returned');
            log('TEST', 'found instances', instances);
            assert.equal(instances.length, 2, 'two instances should be returned');
        });
    });

    describe('launchInstances', () => {
        console.log('Starting launchInstances test');
        // This is a test for the launchInstances method
        test('will launch instances in a group', async () => {
            console.log('Starting single launch test');
            const desiredCount = 3;
            mockWaiters.forInstancePool.mock.mockImplementationOnce((_) => {
                return {
                    instancePool: <core.models.InstancePool>{
                        ...instancePool,
                        size: desiredCount, // this is the critical bit for showing that the instance pool has been updated
                    },
                };
            });

            // the second time listInstancePoolInstances is called, return a new instance with id 'new-instance-id'
            mockComputeManagementClient.listInstancePoolInstances.mock.mockImplementationOnce(
                (_) => {
                    return {
                        // list now includes new-instance-id
                        items: [...instancePoolInstances, { id: 'new-instance-id' }],
                    };
                },
                1, // this is the critical count for mocking the second call instead of the first
            );

            // override group.scalingOptions.desiredCount to control size of instance pool
            const lgroup = { ...group, scalingOptions: { ...group.scalingOptions, desiredCount: desiredCount } };
            const instances = await manager.launchInstances(context, lgroup, currentInventoryInstances, 1);
            assert.equal(
                mockComputeManagementClient.updateInstancePool.mock.callCount(),
                1,
                'updateInstancePool should be called',
            );
            assert.ok(instances, 'some instances should be returned');
            assert.equal(instances[0], 'new-instance-id', 'new instance id should be returned');
            assert.equal(instances.length, 1, 'only one instance should be returned');
            log('TEST', 'ended launchInstances test');
            log('TEST', 'launched instances', instances);
        });

        test('will not launch instances in a group if desiredCount is already reached', async () => {
            console.log('Starting skip launch test');
            const desiredCount = 3;
            // return pool already in desired state
            mockComputeManagementClient.getInstancePool.mock.mockImplementationOnce((_) => {
                return {
                    instancePool: <core.models.InstancePool>{
                        ...instancePool,
                        size: desiredCount,
                    },
                };
            });
            // when listInstancePoolInstances is called, return 3 instances including newest with id 'new-instance-id'
            mockComputeManagementClient.listInstancePoolInstances.mock.mockImplementationOnce((_) => {
                return { items: [...instancePoolInstances, { id: 'new-instance-id' }] };
            });

            // override group.scalingOptions.desiredCount to control size of instance pool
            const lgroup = { ...group, scalingOptions: { ...group.scalingOptions, desiredCount: desiredCount } };
            const instances = await manager.launchInstances(
                context,
                lgroup,
                [...currentInventoryInstances, { instanceId: 'new-instance-id' }],
                1,
            );
            assert.equal(
                mockComputeManagementClient.updateInstancePool.mock.callCount(),
                0,
                'updateInstancePool should not be called',
            );
            assert.equal(instances.length, 0, 'no instances should be returned');
            log('TEST', 'ended skip launch test');
            log('TEST', 'launched instances', instances);
        });

        test('will not launch instances in a group if desiredCount plus shutdown count matches size', async () => {
            console.log('Starting skip launch with shutdown test');
            const desiredCount = 2;
            // return pool already has desired plus shutdown
            mockComputeManagementClient.getInstancePool.mock.mockImplementationOnce((_) => {
                return {
                    instancePool: <core.models.InstancePool>{
                        ...instancePool,
                        size: desiredCount + 1,
                    },
                };
            });
            // when listInstancePoolInstances is called, return 3 instances including newest with id 'new-instance-id'
            mockComputeManagementClient.listInstancePoolInstances.mock.mockImplementationOnce((_) => {
                return { items: [...instancePoolInstances, { id: 'shutting-down-instance-id' }] };
            });

            // override group.scalingOptions.desiredCount to control size of instance pool
            const lgroup = { ...group, scalingOptions: { ...group.scalingOptions, desiredCount: desiredCount } };

            // override the second trimCurrent call to include a shutting down instance
            mockInstanceTracker.trimCurrent.mock.mockImplementationOnce(() => {
                return Promise.resolve([...currentInventoryInstances, { instanceId: 'shutting-down-instance-id' }]);
            }, 1);

            // we pass in currentInventoryInstances (with 2 entries) and expect to have the shutdown instance found via the mock above
            const instances = await manager.launchInstances(context, lgroup, currentInventoryInstances, 1);

            console.log(mockInstanceTracker.trimCurrent.calls);

            assert.equal(
                mockComputeManagementClient.updateInstancePool.mock.callCount(),
                0,
                'updateInstancePool should not be called',
            );
            assert.equal(instances.length, 0, 'no instances should be returned');
            log('TEST', 'ended skip launch with shutdown test');
            log('TEST', 'launched instances', instances);
        });

        test('will not launch instances in a group if size would go down', async () => {
            console.log('Starting skip scale down test');
            const desiredCount = 2;
            // return pool with 1 more than desired
            mockComputeManagementClient.getInstancePool.mock.mockImplementationOnce((_) => {
                return {
                    instancePool: <core.models.InstancePool>{
                        ...instancePool,
                        size: desiredCount + 1,
                    },
                };
            });
            // when listInstancePoolInstances is called, return 3 instances including newest with id 'new-instance-id'
            mockComputeManagementClient.listInstancePoolInstances.mock.mockImplementationOnce((_) => {
                return { items: [...instancePoolInstances, { id: 'new-instance-id' }] };
            });

            // override group.scalingOptions.desiredCount to control size of instance pool
            const lgroup = { ...group, scalingOptions: { ...group.scalingOptions, desiredCount: desiredCount } };
            const instances = await manager.launchInstances(
                context,
                lgroup,
                [...currentInventoryInstances, { instanceId: 'new-instance-id' }],
                1,
            );
            assert.equal(
                mockComputeManagementClient.updateInstancePool.mock.callCount(),
                0,
                'updateInstancePool should not be called',
            );
            assert.equal(instances.length, 0, 'no instances should be returned');
            log('TEST', 'ended skip scale down test');
            log('TEST', 'launched instances', instances);
        });

        test('will see previously launched instances in a group if missed the first time', async () => {
            console.log('Starting find missing instances test');
            const desiredCount = 3;
            // return pool already in desired state
            mockComputeManagementClient.getInstancePool.mock.mockImplementationOnce((_) => {
                return {
                    instancePool: <core.models.InstancePool>{
                        ...instancePool,
                        size: desiredCount,
                    },
                };
            });
            // when listInstancePoolInstances is called, return 3 instances including newest with id 'new-instance-id'
            mockComputeManagementClient.listInstancePoolInstances.mock.mockImplementationOnce((_) => {
                return { items: [...instancePoolInstances, { id: 'new-instance-id' }] };
            });

            // override group.scalingOptions.desiredCount to control size of instance pool
            const lgroup = { ...group, scalingOptions: { ...group.scalingOptions, desiredCount: desiredCount } };

            const instances = await manager.launchInstances(
                context,
                lgroup,
                currentInventoryInstances, // we pass in currentInventoryInstances (with 2 entries) and expect to see the new instance as launched
                1,
            );
            // still expect no pool updates
            assert.equal(
                mockComputeManagementClient.updateInstancePool.mock.callCount(),
                0,
                'updateInstancePool should not be called',
            );
            assert.ok(instances, 'some instances should be returned');
            assert.equal(instances[0], 'new-instance-id', 'new instance id should be returned');
            assert.equal(instances.length, 1, 'only one instance should be returned');
            log('TEST', 'ended find missing instances test');
            log('TEST', 'launched instances', instances);
        });
    });
});
