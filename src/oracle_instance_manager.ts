import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');
import { InstanceGroup } from './instance_group';
import { InstanceTracker, InstanceState } from './instance_tracker';
import { Context } from './context';
import ShutdownManager from './shutdown_manager';
import { ResourceSearchClient } from 'oci-resourcesearch';
import * as resourceSearch from 'oci-resourcesearch';
import { CloudRetryStrategy } from './cloud_manager';
import Audit from './audit';

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
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
    instanceTracker: InstanceTracker;
    shutdownManager: ShutdownManager;
    audit: Audit;
}

export default class OracleInstanceManager {
    private isDryRun: boolean;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private identityClient: identity.IdentityClient;
    private computeManagementClient: core.ComputeManagementClient;
    private instanceTracker: InstanceTracker;
    private shutdownManager: ShutdownManager;
    private audit: Audit;

    constructor(options: OracleInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.instanceTracker = options.instanceTracker;
        this.provider = new common.ConfigFileAuthenticationDetailsProvider(
            options.ociConfigurationFilePath,
            options.ociConfigurationProfile,
        );
        this.identityClient = new identity.IdentityClient({ authenticationDetailsProvider: this.provider });
        this.computeManagementClient = new core.ComputeManagementClient({
            authenticationDetailsProvider: this.provider,
        });
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;

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

        this.computeManagementClient.regionId = group.region;
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
            const launchResponse = await this.computeManagementClient.launchInstanceConfiguration({
                instanceConfigurationId: groupInstanceConfigurationId,
                instanceConfiguration: overwriteComputeInstanceDetails,
            });
            ctx.logger.info(
                `[oracle] Got launch response for instance number ${index + 1} in group ${groupName}`,
                launchResponse,
            );
            await this.audit.saveLaunchEvent(groupName, launchResponse.instance.id);
            const state: InstanceState = {
                instanceId: launchResponse.instance.id,
                instanceType: group.type,
                status: {
                    provisioning: true,
                },
                timestamp: Date.now(),
                metadata: { group: groupName },
            };
            await this.instanceTracker.track(ctx, state);
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
        this.identityClient.regionId = region;
        const availabilityDomainsResponse: identity.responses.ListAvailabilityDomainsResponse = await this.identityClient.listAvailabilityDomains(
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
    ): Promise<Array<resourceSearch.models.ResourceSummary>> {
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

        return instances;
    }
}
