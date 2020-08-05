import OracleCloudManager, { OracleCloudManagerOptions } from './oracle_cloud_manager';

export interface CloudManagerOptions {
    cloud: string;
}

export interface InstanceDetails {
    cloud: string;
    instanceId: string;
    region: string;
    group?: string;
}

import logger from './logger';

export default class CloudManager {
    private cloud = 'aws';
    private oracleCloudManager: OracleCloudManager;

    constructor(options: CloudManagerOptions, oracleOptions: OracleCloudManagerOptions) {
        this.cloud = options.cloud;
        this.oracleCloudManager = new OracleCloudManager(oracleOptions);

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
        // TODO: actually scale down
        return true;
    }
}
