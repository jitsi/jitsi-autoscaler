import { Context } from './context';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import { FullScalingOptionsRequest, FullScalingOptionsResponse, ScalingOptionsRequest } from './handlers';
import Redlock from 'redlock';
import LockManager from './lock_manager';

interface ScalingManagerOptions {
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
}

export default class ScalingManager {
    private instanceGroupManager: InstanceGroupManager;
    private lockManager: LockManager;

    constructor(options: ScalingManagerOptions) {
        this.lockManager = options.lockManager;
        this.instanceGroupManager = options.instanceGroupManager;
    }

    // Used by a scheduler to change the scaling behavior
    async updateFullScalingOptionsForGroups(
        request: FullScalingOptionsRequest,
        ctx: Context,
    ): Promise<FullScalingOptionsResponse> {
        ctx.logger.info(
            `Updating scaling options for groups environment ${request.environment} of type ${request.instanceType} in region ${request.region}, scaling ${request.direction}`,
        );

        const instanceGroupsByRegion = await this.instanceGroupManager.getAllInstanceGroupsByTypeRegionEnvironment(
            ctx,
            request.instanceType,
            request.region,
            request.environment,
        );
        //If the scheduler is not explicitly disabled, consider it enabled
        const instanceGroups = instanceGroupsByRegion.filter(
            (group) => group.enableScheduler == null || group.enableScheduler == true,
        );
        if (instanceGroups.length == 0) {
            ctx.logger.info(
                `No groups of type ${request.instanceType} were found to update in environment ${request.environment} region ${request.region}.
                Found ${instanceGroupsByRegion.length} instance groups, but 0 instances have scheduler enabled`,
            );
            return {
                groupsToBeUpdated: 0,
                groupsUpdated: 0,
            };
        } else {
            let updateFails = 0;
            await Promise.all(
                instanceGroups.map(async (group) => {
                    const success = await this.updateFullScalingOptionsForGroup(ctx, request, group);
                    if (!success) {
                        updateFails++;
                    }
                }),
            );
            ctx.logger.info(
                `Groups of type ${request.instanceType} from environment ${request.environment} region  ${request.region} are now updated with the new scaling options`,
                { instanceType: request.instanceType },
                { region: request.region },
                { fullScalingOptions: request.options },
            );

            if (updateFails > 0) {
                return {
                    groupsToBeUpdated: instanceGroups.length,
                    groupsUpdated: instanceGroups.length - updateFails,
                };
            } else {
                return {
                    groupsToBeUpdated: instanceGroups.length,
                    groupsUpdated: instanceGroups.length,
                };
            }
        }
    }

    private async updateFullScalingOptionsForGroup(
        ctx: Context,
        request: FullScalingOptionsRequest,
        group: InstanceGroup,
    ): Promise<boolean> {
        let lock: Redlock.Lock = undefined;
        let success = true;
        try {
            lock = await this.lockManager.lockGroup(ctx, group.name);
        } catch (err) {
            ctx.logger.warn(`[ScalingOptionsManager] Error obtaining lock for updating group`, { group }, { err });
            return false;
        }

        try {
            const instanceGroup = await this.instanceGroupManager.getInstanceGroup(group.name);
            if (instanceGroup) {
                ScalingManager.setNewScalingOptions(ctx, request.options, instanceGroup, request.direction);
                await this.instanceGroupManager.upsertInstanceGroup(ctx, instanceGroup);
                await this.instanceGroupManager.setAutoScaleGracePeriod(ctx, instanceGroup);
            } else {
                success = false;
            }
        } finally {
            await lock.unlock();
        }

        return success;
    }

    private static setNewScalingOptions(
        ctx: Context,
        request: ScalingOptionsRequest,
        instanceGroup: InstanceGroup,
        direction: string,
    ): void {
        switch (direction) {
            case 'up':
                //we don't want accidentally to scale down
                if (request.desiredCount != null && request.desiredCount > instanceGroup.scalingOptions.desiredCount) {
                    instanceGroup.scalingOptions.desiredCount = request.desiredCount;
                }
                break;
            case 'down':
                //we don't want accidentally to scale up
                if (request.desiredCount != null && request.desiredCount < instanceGroup.scalingOptions.desiredCount) {
                    instanceGroup.scalingOptions.desiredCount = request.desiredCount;
                }
                break;
            default:
                ctx.logger.error(`Direction not supported: ${direction}`);
                throw new Error(`Direction not supported: ${direction}`);
        }

        if (request.maxDesired != null) {
            instanceGroup.scalingOptions.maxDesired = request.maxDesired;
        }
        if (request.minDesired != null) {
            instanceGroup.scalingOptions.minDesired = request.minDesired;
        }
        //ensure the max desired is bigger than desired count
        if (instanceGroup.scalingOptions.maxDesired < instanceGroup.scalingOptions.desiredCount) {
            instanceGroup.scalingOptions.maxDesired = instanceGroup.scalingOptions.desiredCount;
        }
        //ensure the min desired is lower than desired count
        if (instanceGroup.scalingOptions.minDesired > instanceGroup.scalingOptions.desiredCount) {
            instanceGroup.scalingOptions.minDesired = instanceGroup.scalingOptions.desiredCount;
        }

        if (request.scaleUpQuantity != null) {
            instanceGroup.scalingOptions.scaleUpQuantity = request.scaleUpQuantity;
        }
        if (request.scaleDownQuantity != null) {
            instanceGroup.scalingOptions.scaleDownQuantity = request.scaleDownQuantity;
        }
        if (request.scaleUpThreshold != null) {
            instanceGroup.scalingOptions.scaleUpThreshold = request.scaleUpThreshold;
        }
        if (request.scaleDownThreshold != null) {
            instanceGroup.scalingOptions.scaleDownThreshold = request.scaleDownThreshold;
        }
        if (request.scalePeriod != null) {
            instanceGroup.scalingOptions.scalePeriod = request.scalePeriod;
        }
        if (request.scaleUpPeriodsCount != null) {
            instanceGroup.scalingOptions.scaleUpPeriodsCount = request.scaleUpPeriodsCount;
        }
        if (request.scaleDownPeriodsCount != null) {
            instanceGroup.scalingOptions.scaleDownPeriodsCount = request.scaleDownPeriodsCount;
        }
    }
}
