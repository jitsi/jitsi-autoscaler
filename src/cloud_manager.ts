import OracleCloudManager from './oracle_instance_manager';
import OracleInstanceManager from './oracle_instance_manager';
import { InstanceGroup } from './instance_group';
import { InstanceTracker, InstanceDetails, InstanceState } from './instance_tracker';
import { Context } from './context';
import ShutdownManager from './shutdown_manager';
import Audit from './audit';

export interface CloudRetryStrategy {
    maxTimeInSeconds: number;
    maxDelayInSeconds: number;
    retryableStatusCodes: Array<number>;
}

export interface CloudManagerOptions {
    cloudProvider: string;
    shutdownManager: ShutdownManager;
    isDryRun: boolean;
    instanceTracker: InstanceTracker;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
    audit: Audit;
}

export interface CloudInstance {
    instanceId: string;
    displayName: string;
    cloudStatus: string;
}

export default class CloudManager {
    private instanceTracker: InstanceTracker;
    private oracleInstanceManager: OracleInstanceManager;
    private shutdownManager: ShutdownManager;
    private audit: Audit;
    private isDryRun: boolean;

    constructor(options: CloudManagerOptions) {
        this.isDryRun = options.isDryRun;
        if (options.cloudProvider === 'oracle') {
            this.oracleInstanceManager = new OracleCloudManager({
                isDryRun: options.isDryRun,
                ociConfigurationFilePath: options.ociConfigurationFilePath,
                ociConfigurationProfile: options.ociConfigurationProfile,
            });
        }
        this.instanceTracker = options.instanceTracker;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async recordLaunch(
        ctx: Context,
        group: InstanceGroup,
        instanceId: string | boolean,
        isScaleDownProtected: boolean,
    ): Promise<void> {
        if (instanceId) {
            if (!this.isDryRun && instanceId !== true) {
                await this.audit.saveLaunchEvent(group.name, instanceId);
                const state: InstanceState = {
                    instanceId: instanceId,
                    instanceType: group.type,
                    status: {
                        provisioning: true,
                    },
                    timestamp: Date.now(),
                    metadata: { group: group.name },
                };
                await this.instanceTracker.track(ctx, state);
                if (isScaleDownProtected) {
                    await this.shutdownManager.setScaleDownProtected(ctx, instanceId, group.protectedTTLSec);
                    ctx.logger.info(
                        `[CloudManager] Instance ${instanceId} from group ${group.name} is in protected mode`,
                    );
                }
            }
        } else {
            ctx.logger.warn(`[CloudManager] Instance launch failed, instance not recorded from group ${group.name}`);
        }
    }

    async scaleUp(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
        isScaleDownProtected: boolean,
    ): Promise<number> {
        const groupName = group.name;
        ctx.logger.info('[CloudManager] Scaling up', { groupName, quantity });
        // TODO: get the instance manager by cloud
        let scaleUpResult: Array<boolean | string>;

        switch (group.cloud) {
            case 'oracle':
                if (!this.oracleInstanceManager) {
                    ctx.logger.error(`Cloud type not configured: ${group.cloud}`);
                    return 0;
                }
                scaleUpResult = await this.oracleInstanceManager.launchInstances(
                    ctx,
                    group,
                    groupCurrentCount,
                    quantity,
                );
                break;
            default:
                ctx.logger.error(`Cloud type not supported: ${group.cloud}`);
                return 0;
        }

        let scaleUpCount = 0;
        await Promise.all(
            scaleUpResult.map(async (instanceId) => {
                if (instanceId) {
                    scaleUpCount++;
                    return this.recordLaunch(ctx, group, instanceId, isScaleDownProtected);
                }
            }),
        );

        return scaleUpCount;
    }

    async scaleDown(ctx: Context, group: InstanceGroup, instances: Array<InstanceDetails>): Promise<boolean> {
        const groupName = group.name;
        ctx.logger.info('Scaling down', { groupName, instances });
        await this.shutdownManager.setShutdownStatus(ctx, instances);
        ctx.logger.info(`[CloudManager] Finished scaling down all the instances in group ${group.name}`);
        return true;
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<Array<CloudInstance>> {
        if (!this.oracleInstanceManager) {
            return [];
        }
        const oracleInstances = await this.oracleInstanceManager.getInstances(ctx, group, cloudRetryStrategy);
        return oracleInstances
            .map((resourceSummary) => {
                return {
                    instanceId: resourceSummary.identifier,
                    displayName: resourceSummary.displayName,
                    cloudStatus: resourceSummary.lifecycleState,
                };
            })
            .filter(function (instance) {
                return instance.cloudStatus !== 'Terminated';
            });
    }
}
