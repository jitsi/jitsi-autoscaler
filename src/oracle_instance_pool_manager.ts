import core = require('oci-core');
import common = require('oci-common');
import { InstanceGroup } from './instance_group';
import { Context } from './context';
import { CloudRetryStrategy } from './cloud_manager';
import { CloudInstanceManager, CloudInstance } from './cloud_instance_manager';
import { workrequests } from 'oci-sdk';
import { InstanceState } from './instance_tracker';

const maxTimeInSeconds = 60 * 60; // The duration for waiter configuration before failing. Currently set to 1 hour.
const maxDelayInSeconds = 30; // The max delay for the waiter configuration. Currently set to 30 seconds

const waiterConfiguration: common.WaiterConfiguration = {
    terminationStrategy: new common.MaxTimeTerminationStrategy(maxTimeInSeconds),
    delayStrategy: new common.ExponentialBackoffDelayStrategy(maxDelayInSeconds),
};

export interface OracleInstancePoolManagerOptions {
    isDryRun: boolean;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
}

export default class OracleInstancePoolManager implements CloudInstanceManager {
    private isDryRun: boolean;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private computeManagementClient: core.ComputeManagementClient;
    private workRequestClient: workrequests.WorkRequestClient;

    constructor(options: OracleInstancePoolManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.provider = new common.ConfigFileAuthenticationDetailsProvider(
            options.ociConfigurationFilePath,
            options.ociConfigurationProfile,
        );
        this.computeManagementClient = new core.ComputeManagementClient({
            authenticationDetailsProvider: this.provider,
        });
        this.workRequestClient = new workrequests.WorkRequestClient({
            authenticationDetailsProvider: this.provider,
        });

        this.launchInstances = this.launchInstances.bind(this);
    }

    setComputeManagementClient(client: core.ComputeManagementClient) {
        this.computeManagementClient = client;
    }

    getComputeManagementClient() {
        return this.computeManagementClient;
    }

    async detachInstance(ctx: Context, group: InstanceGroup, instance: string): Promise<void> {
        ctx.logger.info(`[oraclepool] Detaching instance ${instance}`);
        this.computeManagementClient.regionId = group.region;

        const cwaiter = this.computeManagementClient.createWaiters(this.workRequestClient, waiterConfiguration);
        const response = await cwaiter.forDetachInstancePoolInstance({
            instancePoolId: group.instanceConfigurationId,
            detachInstancePoolInstanceDetails: { instanceId: instance },
        });
        ctx.logger.info(`[oraclepool] Finished detaching instance ${instance}`, { response });
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        currentInventory: InstanceState[],
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[oraclepool] Launching a batch of ${quantity} instances in group ${group.name}`);

        const result = <string[]>[];

        this.computeManagementClient.regionId = group.region;
        const poolDetails = await this.computeManagementClient.getInstancePool({
            instancePoolId: group.instanceConfigurationId,
        });

        ctx.logger.debug(`[oraclepool] Instance Pool Details for group ${group.name}`, { poolDetails });

        const poolInstances = await this.computeManagementClient.listInstancePoolInstances({
            compartmentId: group.compartmentId,
            instancePoolId: group.instanceConfigurationId,
        });

        const existingInstanceIds = poolInstances.items.map((instance) => {
            return instance.id;
        });

        const currentInstanceIds = currentInventory.map((instance) => {
            return instance.instanceId;
        });

        // mark any instances not previously seen as being launched now
        result.push(
            ...existingInstanceIds.filter((instanceId) => {
                return !currentInstanceIds.includes(instanceId);
            }),
        );

        ctx.logger.debug(`[oraclepool] Instance pool ${group.name} instances`, { instances: poolInstances.items });
        if (result.length > 0) {
            ctx.logger.warn(`[oraclepool] Found instances in pool not in inventory, marking as launched now`, {
                result,
            });
        }

        // always use the group desired count for instance pools
        const newSize = group.scalingOptions.desiredCount;
        if (newSize == poolDetails.instancePool.size) {
            // underlying pool size matches the desired count, so no need to update group
            ctx.logger.info(`[oraclepool] Instance pool ${group.name} size matches desired count, no changes needed`, {
                newSize,
            });
            return result;
        }

        if (this.isDryRun) {
            ctx.logger.info(`[oraclepool] Dry run enabled, instance pool size change skipped`, { newSize });
        } else {
            const updateResult = await this.computeManagementClient.updateInstancePool({
                instancePoolId: group.instanceConfigurationId,
                updateInstancePoolDetails: {
                    size: newSize,
                },
            });

            ctx.logger.info(`[oraclepool] Updated instance pool size for group ${group.name}`, { updateResult });
        }

        this.workRequestClient.regionId = group.region;
        const cwaiter = this.computeManagementClient.createWaiters(this.workRequestClient, waiterConfiguration);
        const runningPool = await cwaiter.forInstancePool(
            {
                instancePoolId: group.instanceConfigurationId,
            },
            core.models.InstancePool.LifecycleState.Running,
        );

        ctx.logger.info(`[oraclepool] Instance pool for ${group.name} back in running state`, { runningPool });

        if (runningPool.instancePool.size == newSize) {
            ctx.logger.debug(`[oraclepool] Instance pool ${group.name} size matches new size`, {
                newSize,
            });
        } else {
            ctx.logger.error(`[oraclepool] Instance pool ${group.name} size DOES NOT matches new size`, {
                newSize,
            });
        }

        const newPoolInstances = await this.computeManagementClient.listInstancePoolInstances({
            compartmentId: group.compartmentId,
            instancePoolId: group.instanceConfigurationId,
        });

        result.push(
            ...newPoolInstances.items
                .map((instance) => {
                    return instance.id;
                })
                .filter((instanceId) => {
                    return !existingInstanceIds.includes(instanceId);
                }),
        );

        ctx.logger.info(`[oraclepool] Finished launching all the instances in group ${group.name}`, { result });

        return result;
    }

    async getInstances(ctx: Context, group: InstanceGroup, _: CloudRetryStrategy): Promise<Array<CloudInstance>> {
        // const computeManagementClient = new core.ComputeManagementClient(
        //     {
        //         authenticationDetailsProvider: this.provider,
        //     },
        //     {
        //         retryConfiguration: {
        //             terminationStrategy: new common.MaxTimeTerminationStrategy(cloudRetryStrategy.maxTimeInSeconds),
        //             delayStrategy: new common.ExponentialBackoffDelayStrategy(cloudRetryStrategy.maxDelayInSeconds),
        //             retryCondition: (response) => {
        //                 return (
        //                     cloudRetryStrategy.retryableStatusCodes.filter((retryableStatusCode) => {
        //                         return response.statusCode === retryableStatusCode;
        //                     }).length > 0
        //                 );
        //             },
        //         },
        //     },
        // );
        const computeManagementClient = this.computeManagementClient;
        computeManagementClient.regionId = group.region;

        const poolInstances = await computeManagementClient.listInstancePoolInstances({
            compartmentId: group.compartmentId,
            instancePoolId: group.instanceConfigurationId,
        });

        return poolInstances.items.map((instance) => {
            ctx.logger.debug('Found instance in oracle pool', { instance });
            return {
                instanceId: instance.id,
                displayName: instance.displayName,
                cloudStatus: instance.state,
            };
        });
    }
}
