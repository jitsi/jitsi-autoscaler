import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');
import { InstanceGroup } from './instance_group';
import { Context } from './context';
import { ResourceSearchClient } from 'oci-resourcesearch';
import * as resourceSearch from 'oci-resourcesearch';
import { CloudRetryStrategy } from './cloud_manager';
import { AbstractCloudInstanceManager, CloudInstanceManager, CloudInstance } from './cloud_instance_manager';

export interface OracleInstanceManagerOptions {
    isDryRun: boolean;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
}

export default class OracleInstanceManager implements CloudInstanceManager {
    private isDryRun: boolean;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private identityClient: identity.IdentityClient;
    private computeManagementClient: core.ComputeManagementClient;

    constructor(options: OracleInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.provider = new common.ConfigFileAuthenticationDetailsProvider(
            options.ociConfigurationFilePath,
            options.ociConfigurationProfile,
        );
        this.identityClient = new identity.IdentityClient({ authenticationDetailsProvider: this.provider });
        this.computeManagementClient = new core.ComputeManagementClient({
            authenticationDetailsProvider: this.provider,
        });

        this.launchInstances = this.launchInstances.bind(this);
        this.getAvailabilityDomains = this.getAvailabilityDomains.bind(this);
        this.getFaultDomains = this.getFaultDomains.bind(this);
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[oracle] Launching a batch of ${quantity} instances in group ${group.name}`);

        this.computeManagementClient.regionId = group.region;
        const availabilityDomains: string[] = await this.getAvailabilityDomains(group.compartmentId, group.region);

        const indexes: Array<number> = [];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        const result = await Promise.all(
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

                return this.launchOracleInstance(ctx, index, group, availabilityDomain, faultDomain);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);

        return result;
    }
    async launchOracleInstance(
        ctx: Context,
        index: number,
        group: InstanceGroup,
        availabilityDomain: string,
        faultDomain: string,
    ): Promise<string | boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

        const displayName = groupName + '-' + AbstractCloudInstanceManager.makeRandomString(5);
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
            return true;
        }
        try {
            const launchResponse = await this.computeManagementClient.launchInstanceConfiguration({
                instanceConfigurationId: groupInstanceConfigurationId,
                instanceConfiguration: overwriteComputeInstanceDetails,
            });
            ctx.logger.info(
                `[oracle] Got launch response for instance number ${index + 1} in group ${groupName}`,
                launchResponse,
            );

            return launchResponse.instance.id;
        } catch (err) {
            ctx.logger.error(
                `[oracle] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
                { err, availabilityDomain, faultDomain },
            );
            return false;
        }
    }

    //TODO in the future, the list of ADs/FDs per region will be loaded once at startup time
    private async getAvailabilityDomains(compartmentId: string, region: string): Promise<string[]> {
        this.identityClient.regionId = region;
        const availabilityDomainsResponse: identity.responses.ListAvailabilityDomainsResponse = await this.identityClient.listAvailabilityDomains(
            {
                compartmentId: compartmentId,
            },
        );
        return availabilityDomainsResponse.items.map((adResponse) => {
            return adResponse.name;
        });
    }

    private async getFaultDomains(
        compartmentId: string,
        region: string,
        availabilityDomain: string,
    ): Promise<string[]> {
        this.identityClient.regionId = region;
        const faultDomainsResponse: identity.responses.ListFaultDomainsResponse = await this.identityClient.listFaultDomains(
            {
                compartmentId: compartmentId,
                availabilityDomain: availabilityDomain,
            },
        );
        return faultDomainsResponse.items.map((fdResponse) => {
            return fdResponse.name;
        });
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<Array<CloudInstance>> {
        const instances: Array<resourceSearch.models.ResourceSummary> = [];

        const resourceSearchClient = new ResourceSearchClient({
            authenticationDetailsProvider: this.provider,
        });
        resourceSearchClient.clientConfiguration = {
            retryConfiguration: {
                terminationStrategy: new common.MaxTimeTerminationStrategy(cloudRetryStrategy.maxTimeInSeconds),
                delayStrategy: new common.ExponentialBackoffDelayStrategy(cloudRetryStrategy.maxDelayInSeconds),
                retryCondition: (response) => {
                    return (
                        cloudRetryStrategy.retryableStatusCodes.filter((retryableStatusCode) => {
                            return response.statusCode === retryableStatusCode;
                        }).length > 0
                    );
                },
            },
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

        return instances.map((resourceSummary) => {
            return {
                instanceId: resourceSummary.identifier,
                displayName: resourceSummary.displayName,
                cloudStatus: resourceSummary.lifecycleState,
            };
        });
    }
}
