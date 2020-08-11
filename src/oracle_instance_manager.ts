import logger from './logger';
import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');
import { InstanceGroup } from './instance_group';

const configurationFilePath = '~/.oci/config';
const configProfile = 'DEFAULT';

const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(
    configurationFilePath,
    configProfile,
);

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

export default class OracleInstanceManager {
    private isDryRun = false;

    private computeManagementClient: core.ComputeManagementClient = new core.ComputeManagementClient({
        authenticationDetailsProvider: provider,
    });

    constructor(isDryRun: boolean) {
        (this.isDryRun = isDryRun), (this.launchInstances = this.launchInstances.bind(this));
    }

    async launchInstances(group: InstanceGroup, groupCurrentCount: number, quantity: number): Promise<boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;
        logger.info(`[oracle] Launching a batch of ${quantity} instances in group ${groupName}`);

        this.computeManagementClient.regionId = group.region;

        const availabilityDomains: string[] = await getAvailabilityDomains(group.compartmentId, group.region);

        for (let i = 0; i < quantity; i++) {
            logger.info(`[oracle] Gathering properties for launching instance ${i} in group ${groupName}`);

            const adIndex: number = (groupCurrentCount + i + 1) % availabilityDomains.length;
            const availabilityDomain = availabilityDomains[adIndex];
            //TODO get instance count per ADs, so that FD can be distributed evenly
            const faultDomains: string[] = await getFaultDomains(group.compartmentId, group.region, availabilityDomain);
            const fdIndex: number = (groupCurrentCount + i + 1) % faultDomains.length;
            const faultDomain = faultDomains[fdIndex];
            const displayName = groupName + '-' + makeRandomString(5);
            const freeformTags = {
                group: groupName,
            };

            const overwriteLaunchDetails: core.models.InstanceConfigurationLaunchInstanceDetails = {
                    availabilityDomain: availabilityDomain,
                    displayName: displayName,
                    freeformTags: freeformTags,
                },
                overwriteComputeInstanceDetails: core.models.ComputeInstanceDetails = {
                    launchDetails: overwriteLaunchDetails,
                    instanceType: 'compute',
                };

            logger.info(`[oracle] Launching instance ${i} in group ${groupName} with properties`, {
                groupName,
                availabilityDomain,
                faultDomain,
                displayName,
                groupInstanceConfigurationId,
                overwriteComputeInstanceDetails,
            });

            if (this.isDryRun) {
                logger.debug('[oracle] Dry run enabled, skipping the instance launch');
                return;
            }
            this.computeManagementClient
                .launchInstanceConfiguration({
                    instanceConfigurationId: groupInstanceConfigurationId,
                    instanceConfiguration: overwriteComputeInstanceDetails,
                })
                .then((launchResponse) => {
                    logger.info(`[oracle] Got launch response for instance ${i} in group ${groupName}`, launchResponse);
                    //TODO interpret/wait for launch final status?
                })
                .catch((launchFailedReason) => {
                    logger.error(
                        `[oracle] Failed launching instance  instance ${i} in group ${groupName}`,
                        launchFailedReason,
                    );
                });
        }

        return true;
    }
}
