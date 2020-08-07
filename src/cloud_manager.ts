import OracleCloudManager, { CloudOptions } from './oracle_instance_manager';

export interface CloudManagerOptions {
    cloud: string;
    instanceStatus: InstanceStatus;
    cloudOptions: CloudOptions;
}

import logger from './logger';
import { InstanceStatus, InstanceDetails } from './instance_status';
import OracleInstanceManager from './oracle_instance_manager';

export default class CloudManager {
    private cloud = 'aws';
    private instanceManager: OracleInstanceManager;
    private instanceStatus: InstanceStatus;

    constructor(options: CloudManagerOptions) {
        this.cloud = options.cloud;
        this.instanceManager = new OracleCloudManager(options.cloudOptions);
        this.instanceStatus = options.instanceStatus;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(group: string, region: string, groupCurrentCount: number, quantity: number): Promise<boolean> {
        logger.info('Scaling up', { cloud: this.cloud, group, region, quantity });
        // TODO: actually scale up
        if (this.cloud == 'oracle') {
            this.instanceManager.launchInstances(group, region, groupCurrentCount, quantity);
        }
        return true;
    }

    async scaleDown(group: string, region: string, instances: Array<InstanceDetails>): Promise<boolean> {
        logger.info('Scaling down', { cloud: this.cloud, group, region, instances });
        instances.forEach((details) => {
            this.instanceStatus.setShutdownStatus(details);
        });
        // TODO: actually scale down
        return true;
    }
}
