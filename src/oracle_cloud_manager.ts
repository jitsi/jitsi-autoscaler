import logger from './logger';
import { CloudManagerOptions, InstanceDetails } from './cloud_manager';

import core = require('oci-core');
import common = require('oci-common');

//TODO implement instance principal auth as well
const configurationFilePath = '~/.oci/config';
const configProfile = 'DEFAULT';

const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(
    configurationFilePath,
    configProfile,
);

//TODO configure instance config id
const instanceConfigurationId =
    'ocid1.instanceconfiguration.oc1.phx.aaaaaaaaued7h55rvp7dwp3hzcgck6ropvycpgxtxcpm6ljwih3e4yw6r4aq';

//This is only for testing purposes
let testOnlyInstanceCreated = false;

export default class OracleCloudManager {
    private computeManagementClient: core.ComputeManagementClient = new core.ComputeManagementClient({
        authenticationDetailsProvider: provider,
    });

    constructor() {
        this.scaleUp = this.scaleUp.bind(this);
        this.scaleDown = this.scaleDown.bind(this);
    }

    async scaleUp(group: string, region: string, quantity: number): Promise<boolean> {
        logger.info('[oracle] Scaling up', { group, region, quantity });

        //TODO use region param
        this.computeManagementClient.regionId = 'us-phoenix-1';

        if (testOnlyInstanceCreated) {
            logger.info('Instances for test already created. Stopping here');
            return;
        }

        for (let i = 0; i < quantity; i++) {
            logger.info('[oracle] Launching instance ', region);

            //TODO pick AD/FD/displayName
            //TODO add free-form tag with group

            const overwriteLaunchDetails: core.models.InstanceConfigurationLaunchInstanceDetails = {
                    availabilityDomain: 'ObqI:PHX-AD-2',
                    displayName: 'testraluca3',
                },
                overwriteComputeInstanceDetails: core.models.ComputeInstanceDetails = {
                    launchDetails: overwriteLaunchDetails,
                    instanceType: 'compute',
                };

            this.computeManagementClient
                .launchInstanceConfiguration({
                    instanceConfigurationId: instanceConfigurationId,
                    instanceConfiguration: overwriteComputeInstanceDetails,
                })
                .then((launchResponse) => {
                    logger.info('[oracle] Got launch response', launchResponse);
                    testOnlyInstanceCreated = true;
                })
                .catch((launchFailedReason) => {
                    logger.error('[oracle] FAILED with reason', launchFailedReason);
                });
        }

        return true;
    }

    async scaleDown(group: string, region: string, instances: Array<InstanceDetails>): Promise<boolean> {
        logger.info('[oracle] Scaling down', { group, region, instances });
        // TODO: actually scale down
        return true;
    }
}
