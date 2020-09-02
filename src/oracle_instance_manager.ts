import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');
import { InstanceGroup } from './instance_group';
import { JibriHealthState, JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';
import { Context } from './context';
import ShutdownManager from './shutdown_manager';
import { ResourceSearchClient } from 'oci-resourcesearch';
import * as resourceSearch from 'oci-resourcesearch';
import { CloudRetryStrategy } from './cloud_manager';

function makeRandomString(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

export interface OracleInstanceManagerOptions {
    isDryRun: boolean;
    cloudRetryStrategy: CloudRetryStrategy;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
    jibriTracker: JibriTracker;
    shutdownManager: ShutdownManager;
}

export default class OracleInstanceManager {
    private isDryRun: boolean;
    private ociRetryConfiguration: common.RetryConfiguration;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private jibriTracker: JibriTracker;
    private shutdownManager: ShutdownManager;

    constructor(options: OracleInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.ociRetryConfiguration = {
            terminationStrategy: new common.MaxTimeTerminationStrategy(options.cloudRetryStrategy.maxTimeInSeconds),
            delayStrategy: new common.ExponentialBackoffDelayStrategy(options.cloudRetryStrategy.maxDelayInSeconds),
            retryCondition: (response) => {
                return (
                    options.cloudRetryStrategy.retryableStatusCodes.filter((retryableStatusCode) => {
                        return response.statusCode === retryableStatusCode;
                    }).length > 0
                );
            },
        };
        this.jibriTracker = options.jibriTracker;
        this.provider = new common.ConfigFileAuthenticationDetailsProvider(
            options.ociConfigurationFilePath,
            options.ociConfigurationProfile,
        );
        this.shutdownManager = options.shutdownManager;

        this.launchInstances = this.launchInstances.bind(this);
        this.getAvailabilityDomains = this.getAvailabilityDomains.bind(this);
        this.getFaultDomains = this.getFaultDomains.bind(this);
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
        isScaleDownProtected: boolean,
    ): Promise<void> {
        ctx.logger.info(`[oracle] Launching a batch of ${quantity} instances in group ${group.name}`);

        const availabilityDomains: string[] = await this.getAvailabilityDomains(group.compartmentId, group.region);

        const indexes: Array<number> = [];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        await Promise.all(
            indexes.map(async (index) => {
                ctx.logger.info(
                    `[oracle] Gathering properties for launching instance number ${index + 1} in group ${group.name}`,
                );

                const adIndex: number = (groupCurrentCount + index + 1) % availabilityDomains.length;
                const availabilityDomain = availabilityDomains[adIndex];
                //TODO get instance count per ADs, so that FD can be distributed evenly
                const faultDomains: string[] = await this.getFaultDomains(
                    group.compartmentId,
                    group.region,
                    availabilityDomain,
                );
                const fdIndex: number = (groupCurrentCount + index + 1) % faultDomains.length;
                const faultDomain = faultDomains[fdIndex];

                await this.launchInstance(ctx, index, group, availabilityDomain, faultDomain, isScaleDownProtected);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);
    }

    async launchInstance(
        ctx: Context,
        index: number,
        group: InstanceGroup,
        availabilityDomain: string,
        faultDomain: string,
        isScaleDownProtected: boolean,
    ): Promise<void> {
        const computeManagementClient = new core.ComputeManagementClient({
            authenticationDetailsProvider: this.provider,
        });
        computeManagementClient.clientConfiguration = {
            retryConfiguration: this.ociRetryConfiguration,
        };
        computeManagementClient.regionId = group.region;

        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

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

        ctx.logger.info(`[oracle] Launching instance number ${index + 1} in group ${groupName} with properties`, {
            groupName,
            availabilityDomain,
            faultDomain,
            displayName,
            groupInstanceConfigurationId,
            overwriteComputeInstanceDetails,
        });

        if (this.isDryRun) {
            ctx.logger.info(`[oracle] Dry run enabled, skipping the instance number ${index + 1} launch`);
            return;
        }
        try {
            const launchResponse = await computeManagementClient.launchInstanceConfiguration({
                instanceConfigurationId: groupInstanceConfigurationId,
                instanceConfiguration: overwriteComputeInstanceDetails,
            });
            ctx.logger.info(
                `[oracle] Got launch response for instance number ${index + 1} in group ${groupName}`,
                launchResponse,
            );
            const state: JibriState = {
                jibriId: launchResponse.instance.id,
                status: {
                    busyStatus: JibriStatusState.Provisioning,
                    health: {
                        healthStatus: JibriHealthState.Healthy,
                    },
                },
                timestamp: Date.now(),
                metadata: { group: groupName },
            };
            await this.jibriTracker.track(ctx, state);
            if (isScaleDownProtected) {
                await this.shutdownManager.setScaleDownProtected(
                    ctx,
                    launchResponse.instance.id,
                    group.protectedTTLSec,
                );
                ctx.logger.info(
                    `[oracle] Instance ${launchResponse.instance.id} from group ${groupName} is in protected mode`,
                );
            }
        } catch (err) {
            ctx.logger.error(`[oracle] Failed launching instance number ${index + 1} in group ${groupName}`, err);
        }
    }

    //TODO in the future, the list of ADs/FDs per region will be loaded once at startup time
    private async getAvailabilityDomains(compartmentId: string, region: string): Promise<string[]> {
        const identityClient = new identity.IdentityClient({ authenticationDetailsProvider: this.provider });
        identityClient.clientConfiguration = {
            retryConfiguration: this.ociRetryConfiguration,
        };
        identityClient.regionId = region;

        const availabilityDomainsResponse: identity.responses.ListAvailabilityDomainsResponse = await identityClient.listAvailabilityDomains(
            {
                compartmentId: compartmentId,
            },
        );
        return availabilityDomainsResponse.items
            .filter((adResponse) => {
                if (region.toString() == 'eu-frankfurt-1') {
                    return adResponse.name.endsWith('1') || adResponse.name.endsWith('2');
                } else {
                    return true;
                }
            })
            .map((adResponse) => {
                return adResponse.name;
            });
    }

    private async getFaultDomains(
        compartmentId: string,
        region: string,
        availabilityDomain: string,
    ): Promise<string[]> {
        const identityClient = new identity.IdentityClient({ authenticationDetailsProvider: this.provider });
        identityClient.clientConfiguration = {
            retryConfiguration: this.ociRetryConfiguration,
        };
        identityClient.regionId = region;

        const faultDomainsResponse: identity.responses.ListFaultDomainsResponse = await identityClient.listFaultDomains(
            {
                compartmentId: compartmentId,
                availabilityDomain: availabilityDomain,
            },
        );
        return faultDomainsResponse.items.map((fdResponse) => {
            return fdResponse.name;
        });
    }

    async getInstances(ctx: Context, group: InstanceGroup): Promise<Array<resourceSearch.models.ResourceSummary>> {
        const instances: Array<resourceSearch.models.ResourceSummary> = [];

        const resourceSearchClient = new ResourceSearchClient({
            authenticationDetailsProvider: this.provider,
        });
        resourceSearchClient.clientConfiguration = {
            retryConfiguration: this.ociRetryConfiguration,
        };
        resourceSearchClient.regionId = group.region;

        const structuredSearch: resourceSearch.models.StructuredSearchDetails = {
            query: `query instance resources where (freeformTags.key = 'group' && freeformTags.value = '${group.name}')`,
            type: 'Structured',
            matchingContextType: resourceSearch.models.SearchDetails.MatchingContextType.None,
        };

        const structuredSearchRequest: resourceSearch.requests.SearchResourcesRequest = {
            searchDetails: structuredSearch,
        };
        const searchResourcesResponse: resourceSearch.responses.SearchResourcesResponse = await resourceSearchClient.searchResources(
            structuredSearchRequest,
        );
        if (
            searchResourcesResponse.resourceSummaryCollection &&
            searchResourcesResponse.resourceSummaryCollection.items
        ) {
            for (let i = 0; i < searchResourcesResponse.resourceSummaryCollection.items.length; i++) {
                const resourceSummary: resourceSearch.models.ResourceSummary =
                    searchResourcesResponse.resourceSummaryCollection.items[i];
                ctx.logger.debug('Found instance in oracle', { resourceSummary });
                instances.push(resourceSummary);
            }
        }

        return instances;
    }
}
