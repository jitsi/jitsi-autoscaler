import OracleCloudManager from './oracle_instance_manager';
import { InstanceDetails, InstanceStatus } from './instance_status';
import OracleInstanceManager from './oracle_instance_manager';
import { InstanceGroup } from './instance_group';
import { JibriTracker } from './jibri_tracker';
import { Context } from './context';
import ShutdownManager from './shutdown_manager';

export interface CloudRetryStrategy {
    maxTimeInSeconds: number;
    maxDelayInSeconds: number;
    retryableStatusCodes: Array<number>;
}

export interface CloudManagerOptions {
    instanceStatus: InstanceStatus;
    shutdownManager: ShutdownManager;
    isDryRun: boolean;
    cloudRetryStrategy: CloudRetryStrategy;
    jibriTracker: JibriTracker;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
}

export interface CloudInstance {
    instanceId: string;
    displayName: string;
    cloudStatus: string;
}

export default class CloudManager {
    private oracleInstanceManager: OracleInstanceManager;
    private shutdownManager: ShutdownManager;
    private isDryRun: boolean;

    constructor(options: CloudManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.oracleInstanceManager = new OracleCloudManager({
            isDryRun: options.isDryRun,
            cloudRetryStrategy: options.cloudRetryStrategy,
            ociConfigurationFilePath: options.ociConfigurationFilePath,
            ociConfigurationProfile: options.ociConfigurationProfile,
            jibriTracker: options.jibriTracker,
            shutdownManager: options.shutdownManager,
        });
        this.shutdownManager = options.shutdownManager;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
        isScaleDownProtected: boolean,
    ): Promise<boolean> {
        const groupName = group.name;
        ctx.logger.info('Scaling up', { groupName, quantity });
        // TODO: get the instance manager by cloud
        if (group.cloud == 'oracle') {
            await this.oracleInstanceManager.launchInstances(
                ctx,
                group,
                groupCurrentCount,
                quantity,
                isScaleDownProtected,
            );
        }
        return true;
    }

    async scaleDown(ctx: Context, group: InstanceGroup, instances: Array<InstanceDetails>): Promise<boolean> {
        const groupName = group.name;
        ctx.logger.info('Scaling down', { groupName, instances });
        await Promise.all(
            instances.map((details) => {
                return this.shutdownManager.setShutdownStatus(ctx, details);
            }),
        );
        ctx.logger.info(`Finished scaling down all the instances in group ${group.name}`);
        return true;
    }

    async getInstances(ctx: Context, group: InstanceGroup): Promise<Array<CloudInstance>> {
        const oracleInstances = await this.oracleInstanceManager.getInstances(ctx, group);
        return oracleInstances.map((resourceSummary) => {
            return {
                instanceId: resourceSummary.identifier,
                displayName: resourceSummary.displayName,
                cloudStatus: resourceSummary.lifecycleState,
            };
        });
    }
}
