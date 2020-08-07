import logger from './logger';

import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');

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

const identityClient = new identity.IdentityClient({ authenticationDetailsProvider: provider });

//TODO in the future, the list of ADs/FDs per region will be loaded once at startup time
async function getAvailabilityDomains(compartmentId: string, region: string) {
    identityClient.regionId = region;
    const availabilityDomainsResponse: identity.responses.ListAvailabilityDomainsResponse = await identityClient.listAvailabilityDomains(
        {
            compartmentId: compartmentId,
        },
    );
    return availabilityDomainsResponse.items
        .filter((adResponse) => {
            if (region.toString() == 'eu-frankfurt-1') {
                if (adResponse.name.endsWith('1') || adResponse.name.endsWith('2')) {
                    return true;
                } else {
                    return false;
                }
            } else {
                return true;
            }
        })
        .map((adResponse) => {
            return adResponse.name;
        });
}

async function getFaultDomains(compartmentId: string, region: string, availabilityDomain: string): Promise<string[]> {
    identityClient.regionId = region;
    const faultDomainsResponse: identity.responses.ListFaultDomainsResponse = await identityClient.listFaultDomains({
        compartmentId: compartmentId,
        availabilityDomain: availabilityDomain,
    });
    return faultDomainsResponse.items.map((fdResponse) => {
        return fdResponse.name;
    });
}

export interface CloudOptions {
    //TODO this should be a config per region and compartment?
    instanceConfigurationId: string;
    compartmentId: string;
}

export default class OracleInstanceManager {
    private instanceConfigurationId: string;
    private compartmentId: string;

    private computeManagementClient: core.ComputeManagementClient = new core.ComputeManagementClient({
        authenticationDetailsProvider: provider,
    });

    constructor(options: CloudOptions) {
        this.instanceConfigurationId = options.instanceConfigurationId;
        this.compartmentId = options.compartmentId;

        this.launchInstances = this.launchInstances.bind(this);
    }

    async launchInstances(
        group: string,
        region: string,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<boolean> {
        logger.info('[oracle] Launching a batch of instances', { group, region, groupCurrentCount, quantity });

        //TODO use region param
        const usedRegion = 'us-phoenix-1';
        this.computeManagementClient.regionId = usedRegion;

        if (testOnlyInstanceCreated) {
            logger.info('Instances for test already created. Stopping here');
            return;
        }

        const availabilityDomains: string[] = await getAvailabilityDomains(this.compartmentId, usedRegion);

        for (let i = 0; i < quantity; i++) {
            logger.info('[oracle] Gathering properties for launching instance ', region);

            const adIndex: number = (groupCurrentCount + i + 1) % availabilityDomains.length;
            const availabilityDomain = availabilityDomains[adIndex];
            //TODO get instance count per ADs, so that FD can be distributed evenly
            const faultDomains: string[] = await getFaultDomains(this.compartmentId, usedRegion, availabilityDomain);
            const fdIndex: number = (groupCurrentCount + i + 1) % faultDomains.length;
            const faultDomain = faultDomains[fdIndex];
            const displayName = group + '-' + usedRegion + '-' + makeRandomString(5);
            const freeformTags = {
                group: group,
            };

            logger.info('[oracle] Launching instance with properties ', {
                region,
                availabilityDomain,
                faultDomain,
                displayName,
            });

            const overwriteLaunchDetails: core.models.InstanceConfigurationLaunchInstanceDetails = {
                    availabilityDomain: availabilityDomain,
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
                    //TODO interpret/wait for launch final status?
                    testOnlyInstanceCreated = true;
                })
                .catch((launchFailedReason) => {
                    logger.error('[oracle] Failed launching instance with reason', launchFailedReason);
                });
        }

        return true;
    }
}
