import logger from './logger';

import core = require('oci-core');
import common = require('oci-common');

//TODO implement instance principal auth as well
const configurationFilePath = '~/.oci/config';
const configProfile = 'DEFAULT';

const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(
    configurationFilePath,
    configProfile,
);

//TODO remove this, as it is only for testing purposes
let testOnlyInstanceCreated = false;

function makeRandomString(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

export interface OracleCloudManagerOptions {
    instanceConfigurationId: string;
}

export default class OracleCloudManager {
    private instanceConfigurationId: string;

    private computeManagementClient: core.ComputeManagementClient = new core.ComputeManagementClient({
        authenticationDetailsProvider: provider,
    });

    constructor(options: OracleCloudManagerOptions) {
        this.instanceConfigurationId = options.instanceConfigurationId;

        this.launchInstances = this.launchInstances.bind(this);
    }

    async launchInstances(group: string, region: string, quantity: number): Promise<boolean> {
        logger.info('[oracle] Launching a batch of instances', { group, region, quantity });

        //TODO use region param
        this.computeManagementClient.regionId = 'us-phoenix-1';

        if (testOnlyInstanceCreated) {
            logger.info('Instances for test already created. Stopping here');
            return;
        }

        for (let i = 0; i < quantity; i++) {
            logger.info('[oracle] Launching instance ', region);

            //TODO pick AD/FD

            const displayName = group + '-' + this.computeManagementClient.regionId + '-' + makeRandomString(5);
            const freeformTags = {
                group: group,
            };

            const overwriteLaunchDetails: core.models.InstanceConfigurationLaunchInstanceDetails = {
                    availabilityDomain: 'ObqI:PHX-AD-2',
                    displayName: displayName,
                    freeformTags: freeformTags,
                },
                overwriteComputeInstanceDetails: core.models.ComputeInstanceDetails = {
                    launchDetails: overwriteLaunchDetails,
                    instanceType: 'compute',
                };

            this.computeManagementClient
                .launchInstanceConfiguration({
                    instanceConfigurationId: this.instanceConfigurationId,
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
}
