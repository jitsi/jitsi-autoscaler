import OracleCloudManager from './oracle_instance_manager';
import logger from './logger';
import { InstanceStatus, InstanceDetails } from './instance_status';
import OracleInstanceManager from './oracle_instance_manager';
import { InstanceGroup } from './instance_group';
import { JibriTracker } from './jibri_tracker';

export interface CloudManagerOptions {
    instanceStatus: InstanceStatus;
    isDryRun: boolean;
    jibriTracker: JibriTracker;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
}

export default class CloudManager {
    private oracleInstanceManager: OracleInstanceManager;
    private instanceStatus: InstanceStatus;
    private isDryRun: boolean;

    constructor(options: CloudManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.oracleInstanceManager = new OracleCloudManager({
            isDryRun: options.isDryRun,
            ociConfigurationFilePath: options.ociConfigurationFilePath,
            ociConfigurationProfile: options.ociConfigurationProfile,
            jibriTracker: options.jibriTracker,
        });
        this.instanceStatus = options.instanceStatus;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(group: InstanceGroup, groupCurrentCount: number, quantity: number): Promise<boolean> {
        const groupName = group.name;
        logger.info('Scaling up', { groupName, quantity });
        // TODO: get the instance manager by cloud
        if (group.cloud == 'oracle') {
            await this.oracleInstanceManager.launchInstances(group, groupCurrentCount, quantity);
        }
        return true;
    }

    async scaleDown(group: InstanceGroup, instances: Array<InstanceDetails>): Promise<boolean> {
        const groupName = group.name;
        logger.info('Scaling down', { groupName, instances });
        await Promise.all(
            instances.map((details) => {
                return this.instanceStatus.setShutdownStatus(details);
            }),
        );
        logger.info(`Finished scaling down all the instances in group ${group.name}`);
        return true;
    }
}
