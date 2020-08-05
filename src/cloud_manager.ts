import OracleCloudManager, { OracleCloudManagerOptions } from './oracle_cloud_manager';

export interface CloudManagerOptions {
    cloud: string;
    instanceStatus: InstanceStatus;
}

import logger from './logger';
import { InstanceStatus, InstanceDetails } from './instance_status';

export default class CloudManager {
    private cloud = 'aws';
    private oracleCloudManager: OracleCloudManager;
    private instanceStatus: InstanceStatus;

    constructor(options: CloudManagerOptions, oracleOptions: OracleCloudManagerOptions) {
        this.cloud = options.cloud;
        this.oracleCloudManager = new OracleCloudManager(oracleOptions);
        this.instanceStatus = options.instanceStatus;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(group: string, region: string, quantity: number): Promise<boolean> {
        logger.info('Scaling up', { cloud: this.cloud, group, region, quantity });
        // TODO: actually scale up
        if (this.cloud == 'oracle') {
            this.oracleCloudManager.launchInstances(group, region, quantity);
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
