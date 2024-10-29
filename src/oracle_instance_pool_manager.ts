import core = require('oci-core');
import common = require('oci-common');
import { InstanceGroup } from './instance_group';
import { Context } from './context';
import { CloudRetryStrategy } from './cloud_manager';
import { CloudInstanceManager, CloudInstance } from './cloud_instance_manager';
import { workrequests } from 'oci-sdk';
import { InstanceState, InstanceTracker } from './instance_tracker';

const maxLaunchTimeInSeconds = 30; // The duration for waiter configuration before failing. Currently set to 30 seconds
const launchDelayInSeconds = 5; // The max delay for the waiter configuration. Currently set to 10 seconds

const maxDetachTimeInSeconds = 180; // The duration for waiter configuration before failing. Currently set to 180 seconds
const maxDetachDelayInSeconds = 30; // The max delay for the waiter configuration. Currently set to 30 seconds

const launchWaiterConfiguration: common.WaiterConfiguration = {
    terminationStrategy: new common.MaxTimeTerminationStrategy(maxLaunchTimeInSeconds),
    delayStrategy: new common.FixedTimeDelayStrategy(launchDelayInSeconds),
};

const detachWaiterConfiguration: common.WaiterConfiguration = {
    terminationStrategy: new common.MaxTimeTerminationStrategy(maxDetachTimeInSeconds),
    delayStrategy: new common.ExponentialBackoffDelayStrategy(maxDetachDelayInSeconds),
};

export interface OracleInstancePoolManagerOptions {
    isDryRun: boolean;
    instanceTracker: InstanceTracker;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
}

export default class OracleInstancePoolManager implements CloudInstanceManager {
    private instanceTracker: InstanceTracker;
    private isDryRun: boolean;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private computeManagementClient: core.ComputeManagementClient;
    private workRequestClient: workrequests.WorkRequestClient;

    constructor(options: OracleInstancePoolManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.instanceTracker = options.instanceTracker;
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

        const cwaiter = this.computeManagementClient.createWaiters(this.workRequestClient, detachWaiterConfiguration);
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

        const fullInventory = await this.instanceTracker.trimCurrent(ctx, group.name, false);

        const currentInstanceIds = currentInventory.map((instance) => {
            return instance.instanceId;
        });

        const shuttingDownInstances = fullInventory
            .filter((instance) => {
                return !currentInstanceIds.includes(instance.instanceId);
            })
            .map((instance) => {
                return instance.instanceId;
            });

        // mark any instances not previously seen as being launched now
        result.push(
            ...existingInstanceIds.filter((instanceId) => {
                return !shuttingDownInstances.includes(instanceId) && !currentInstanceIds.includes(instanceId);
            }),
        );

        ctx.logger.debug(`[oraclepool] Instance pool ${group.name} instances`, { instances: poolInstances.items });
        if (result.length > 0) {
            ctx.logger.warn(`[oraclepool] Found instances in pool not in inventory, marking as launched now`, {
                result,
            });
        }

        // always use the group desired count + shutting down count for instance pools
        const newSize = group.scalingOptions.desiredCount + shuttingDownInstances.length;
        if (newSize == poolDetails.instancePool.size) {
            // underlying pool size matches the desired count, so no need to update group
            ctx.logger.info(`[oraclepool] Instance pool ${group.name} size matches desired count, no changes needed`, {
                newSize,
            });
            return result;
        }

        // never scale down via size, always do so by detaching instances on shutdown confirmation
        if (newSize < poolDetails.instancePool.size) {
            // underlying pool size would shrink with new size, so waiting for instances to be detached after confirming shutdown
            ctx.logger.warn(`[oraclepool] Instance pool ${group.name} size would shrink, no changes applied`, {
                size: poolDetails.instancePool.size,
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
        const cwaiter = this.computeManagementClient.createWaiters(this.workRequestClient, launchWaiterConfiguration);
        try {
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
        } catch (err) {
            ctx.logger.error(`[oraclepool] Instance pool for ${group.name} failed to return to running state`, { err });
            // the next launch job will eventually see the new instances and return them
        }

        ctx.logger.debug(`[oraclepool] Instance pool ${group.name} listing pool instances`);

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
        const computeManagementClient = this.computeManagementClient;
        computeManagementClient.regionId = group.region;

        const poolInstances = await computeManagementClient.listInstancePoolInstances({
            compartmentId: group.compartmentId,
            instancePoolId: group.instanceConfigurationId,
        });

        return poolInstances.items.map((instance) => {
            ctx.logger.debug('[oraclepool] Found instance in oracle pool', { instance });
            return {
                instanceId: instance.id,
                displayName: instance.displayName,
                cloudStatus: instance.state,
            };
        });
    }
}
