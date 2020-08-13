import OracleCloudManager from './oracle_instance_manager';
import logger from './logger';
import { InstanceStatus, InstanceDetails } from './instance_status';
import OracleInstanceManager from './oracle_instance_manager';
import { InstanceGroup } from './instance_group';

export interface CloudManagerOptions {
    instanceStatus: InstanceStatus;
    isDryRun: boolean;
}

export default class CloudManager {
    private oracleInstanceManager: OracleInstanceManager;
    private instanceStatus: InstanceStatus;
    private isDryRun: boolean;

    constructor(options: CloudManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.oracleInstanceManager = new OracleCloudManager(this.isDryRun);
        this.instanceStatus = options.instanceStatus;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(group: InstanceGroup, groupCurrentCount: number, quantity: number): Promise<boolean> {
        const groupName = group.name;
        logger.info('Scaling up', { groupName, quantity });
        // TODO: get the instance manager by cloud
        if (group.cloud == 'oracle') {
            this.oracleInstanceManager.launchInstances(group, groupCurrentCount, quantity);
        }
        return true;
    }

    async scaleDown(group: InstanceGroup, instances: Array<InstanceDetails>): Promise<boolean> {
        const groupName = group.name;
        logger.info('Scaling down', { groupName, instances });
        instances.forEach((details) => {
            this.instanceStatus.setShutdownStatus(details);
        });
        return true;
    }
}
