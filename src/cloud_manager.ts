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

    constructor(options: CloudManagerOptions) {
        this.cloud = options.cloud;

        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(group: string, region: string, quantity: number): Promise<boolean> {
        logger.info('Scaling up', { cloud: this.cloud, group, region, quantity });
        // TODO: actually scale up
        return true;
    }

    async scaleDown(group: string, region: string, instances: Array<InstanceDetails>): Promise<boolean> {
        logger.info('Scaling down', { cloud: this.cloud, group, region, instances });
        // TODO: actually scale down
        return true;
    }
}