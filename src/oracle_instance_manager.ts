import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');
// declared in oci-common's waiter module but not re-exported from its index
import { ExponentialBackoffDelayStrategyWithJitter } from 'oci-common/lib/waiter';
import { randomUUID } from 'crypto';
import { Context } from './context';
import { ResourceSearchClient } from 'oci-resourcesearch';
import * as resourceSearch from 'oci-resourcesearch';
import { CloudRetryStrategy } from './cloud_manager';
import {
    AbstractCloudInstanceManager,
    CloudInstanceManager,
    CloudInstance,
    DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS,
} from './cloud_instance_manager';
import { InstanceGroup } from './instance_store';

// disable circuit breaker
common.CircuitBreaker.EnableGlobalCircuitBreaker = false;

export interface FaultDomainMap {
    [key: string]: string[];
}

export interface PlacementTarget {
    availabilityDomain: string;
    faultDomain: string;
}

export interface OracleInstanceManagerOptions {
    isDryRun: boolean;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;
    // per-request HTTP timeout applied to every OCI client (identity, compute, resource search)
    cloudProviderRequestTimeoutMs?: number;
}

// maximum page size accepted by the OCI resource search API
const OCI_SEARCH_PAGE_LIMIT = 1000;
// hard stop for pagination, in case the API keeps handing back a next page token
const OCI_SEARCH_MAX_PAGES = 100;

/**
 * Escape a value for interpolation inside a single-quoted literal of an OCI structured
 * search query. Backslashes and single quotes are the only characters that can terminate
 * or alter the literal.
 */
export function escapeOciQueryLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Availability domains that have at least one known fault domain, in their original order.
 */
export function usableAvailabilityDomains(availabilityDomains: string[], faultDomainsByAD: FaultDomainMap): string[] {
    return availabilityDomains.filter((availabilityDomain) => {
        const faultDomains = faultDomainsByAD[availabilityDomain];
        return Array.isArray(faultDomains) && faultDomains.length > 0;
    });
}

/**
 * Flatten the (AD, FD) pairs in a stable order: ADs in the given order, each AD's fault
 * domains in the order returned by OCI. ADs without known fault domains are skipped.
 */
export function buildPlacementTargets(
    availabilityDomains: string[],
    faultDomainsByAD: FaultDomainMap,
): PlacementTarget[] {
    const targets: PlacementTarget[] = [];
    for (const availabilityDomain of usableAvailabilityDomains(availabilityDomains, faultDomainsByAD)) {
        for (const faultDomain of faultDomainsByAD[availabilityDomain]) {
            targets.push({ availabilityDomain, faultDomain });
        }
    }
    return targets;
}

export function selectAvailabilityDomain(
    index: number,
    groupCurrentCount: number,
    availabilityDomains: string[],
): string | undefined {
    if (availabilityDomains.length === 0) {
        return undefined;
    }
    const adIndex: number = (groupCurrentCount + index + 1) % availabilityDomains.length;
    return availabilityDomains[adIndex];
}

export function selectFaultDomain(
    index: number,
    groupCurrentCount: number,
    availabilityDomain: string,
    faultDomainsByAD: FaultDomainMap,
): string | undefined {
    //TODO get instance count per ADs, so that FD can be distributed evenly
    const faultDomains = faultDomainsByAD[availabilityDomain];
    if (!Array.isArray(faultDomains) || faultDomains.length === 0) {
        return undefined;
    }
    const fdIndex: number = (groupCurrentCount + index + 1) % faultDomains.length;
    return faultDomains[fdIndex];
}

/**
 * Pick the placement for the `retries`-th attempt at launching instance `index`.
 *
 * Attempt 0 uses the round-robin AD/FD selection. Every subsequent retry moves to the next
 * (AD, FD) pair in the flattened placement list, so retries cycle through every fault
 * domain of the selected AD before moving on to the next AD, wrapping around at the end.
 * Returns undefined when no AD has a known fault domain.
 */
export function selectPlacement(
    index: number,
    groupCurrentCount: number,
    retries: number,
    availabilityDomains: string[],
    faultDomainsByAD: FaultDomainMap,
): PlacementTarget | undefined {
    const targets = buildPlacementTargets(availabilityDomains, faultDomainsByAD);
    if (targets.length === 0) {
        return undefined;
    }
    const usableADs = usableAvailabilityDomains(availabilityDomains, faultDomainsByAD);
    const availabilityDomain = selectAvailabilityDomain(index, groupCurrentCount, usableADs);
    const faultDomain = selectFaultDomain(index, groupCurrentCount, availabilityDomain, faultDomainsByAD);
    const base = Math.max(
        0,
        targets.findIndex((t) => t.availabilityDomain === availabilityDomain && t.faultDomain === faultDomain),
    );
    return targets[(base + retries) % targets.length];
}

export default class OracleInstanceManager implements CloudInstanceManager {
    private isDryRun: boolean;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private requestTimeoutMs: number;
    // Clients are region-scoped and cached per region rather than shared as a single mutable
    // instance. The OCI SDK clients carry region as instance state (`.regionId`); mutating a
    // shared client from concurrent launches/lookups for different regions is a race, since
    // job processing is concurrent (JOBS_CONCURRENCY > 1) and requests can be sent out under
    // whichever region happened to be set most recently by an unrelated concurrent call.
    private identityClientsByRegion: Map<string, identity.IdentityClient> = new Map();
    private computeManagementClientsByRegion: Map<string, core.ComputeManagementClient> = new Map();

    constructor(options: OracleInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.requestTimeoutMs = options.cloudProviderRequestTimeoutMs ?? DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS;
        this.provider = new common.ConfigFileAuthenticationDetailsProvider(
            options.ociConfigurationFilePath,
            options.ociConfigurationProfile,
        );

        this.launchInstances = this.launchInstances.bind(this);
        this.getAvailabilityDomains = this.getAvailabilityDomains.bind(this);
        this.getFaultDomains = this.getFaultDomains.bind(this);
    }

    /**
     * Client configuration shared by all OCI clients.
     *
     * NOTE: `httpOptions.timeout` is NOT an effective request timeout. oci-common hands
     * `httpOptions` to the global `fetch`; isomorphic-fetch only installs node-fetch when no
     * global fetch exists, and Node >= 18 always ships undici's fetch, which ignores a
     * `timeout` init key. It is kept only as a hint for the (unused) node-fetch path; the
     * real bound is enforced by `withTimeout` around every SDK call.
     */
    private clientConfiguration(retryConfiguration?: common.RetryConfiguration): common.ClientConfiguration {
        const configuration: common.ClientConfiguration = {
            httpOptions: { timeout: this.requestTimeoutMs },
        };
        if (retryConfiguration) {
            configuration.retryConfiguration = retryConfiguration;
        }
        return configuration;
    }

    /**
     * Race an OCI SDK call against a timer so that a hung endpoint cannot stall a job (and the
     * group lock it holds) forever. Rejects with an Error named `TimeoutError` whose message
     * names the operation (`what` should name the operation, group and region). The timer is
     * cleared as soon as the call settles, so a fast response leaves nothing pending.
     */
    private withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                const err = new Error(`${what} timed out after ${ms}ms`);
                err.name = 'TimeoutError';
                reject(err);
            }, ms);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            );
        });
    }

    private static isTimeoutError(err: unknown): boolean {
        return err instanceof Error && err.name === 'TimeoutError';
    }

    private getIdentityClient(region: string): identity.IdentityClient {
        let client = this.identityClientsByRegion.get(region);
        if (!client) {
            client = new identity.IdentityClient(
                { authenticationDetailsProvider: this.provider },
                this.clientConfiguration(),
            );
            client.regionId = region;
            this.identityClientsByRegion.set(region, client);
        }
        return client;
    }

    private getComputeManagementClient(region: string): core.ComputeManagementClient {
        let client = this.computeManagementClientsByRegion.get(region);
        if (!client) {
            client = new core.ComputeManagementClient(
                { authenticationDetailsProvider: this.provider },
                this.clientConfiguration(),
            );
            client.regionId = region;
            this.computeManagementClientsByRegion.set(region, client);
        }
        return client;
    }

    /**
     * Launches `quantity` instances. Never rejects: every entry of the result is either the
     * launched instance id, `true` (dry run) or `false` (failed), so a single failure can
     * not lose the ids of sibling launches.
     */
    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[oracle] Launching a batch of ${quantity} instances in group ${group.name}`);

        const failedBatch = (): Array<string | boolean> => new Array<string | boolean>(quantity).fill(false);

        let availabilityDomains: string[];
        let faultDomainsByAD: FaultDomainMap;
        try {
            availabilityDomains = await this.getAvailabilityDomains(group);
            faultDomainsByAD = await this.getFaultDomainsByAD(ctx, group, availabilityDomains);
        } catch (err) {
            ctx.logger.error(
                `[oracle] Failed listing availability/fault domains for group ${group.name}, no instances launched: ${err}`,
                { err },
            );
            return failedBatch();
        }

        const usableADs = usableAvailabilityDomains(availabilityDomains, faultDomainsByAD);
        if (usableADs.length === 0) {
            ctx.logger.error(
                `[oracle] No availability domain with known fault domains for group ${group.name}, no instances launched`,
                { availabilityDomains },
            );
            return failedBatch();
        }
        if (usableADs.length < availabilityDomains.length) {
            ctx.logger.warn(`[oracle] Launching in group ${group.name} with a reduced set of availability domains`, {
                availabilityDomains,
                usableAvailabilityDomains: usableADs,
            });
        }

        const indexes = <number[]>[];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        const settled = await Promise.allSettled(
            indexes.map(async (index) => {
                ctx.logger.info(
                    `[oracle] Gathering properties for launching instance number ${index + 1} in group ${group.name}`,
                );

                return this.launchOracleInstance(ctx, index, group, groupCurrentCount, usableADs, faultDomainsByAD);
            }),
        );

        const result = settled.map((outcome, index): string | boolean => {
            if (outcome.status === 'fulfilled') {
                return outcome.value;
            }
            ctx.logger.error(
                `[oracle] Unexpected rejection launching instance number ${index + 1} in group ${group.name}: ${
                    outcome.reason
                }`,
                { err: outcome.reason },
            );
            return false;
        });
        const succeeded = result.filter((r) => r !== false).length;
        ctx.logger.info(
            `[oracle] Finished launching batch in group ${group.name}: ${succeeded} of ${quantity} launches succeeded`,
        );

        return result;
    }

    /**
     * Fault domains keyed by availability domain. ADs whose fault domain lookup failed or
     * returned nothing are left out of the map, so callers must only place instances in
     * ADs present as keys.
     */
    async getFaultDomainsByAD(
        ctx: Context,
        group: InstanceGroup,
        availabilityDomains: string[],
    ): Promise<FaultDomainMap> {
        const faultDomainsByAD: FaultDomainMap = {};
        const outcomes = await Promise.allSettled(
            availabilityDomains.map((availabilityDomain) => this.getFaultDomains(group, availabilityDomain)),
        );
        outcomes.forEach((outcome, i) => {
            const availabilityDomain = availabilityDomains[i];
            if (outcome.status === 'rejected') {
                ctx.logger.error(
                    `[oracle] Failed listing fault domains for availability domain ${availabilityDomain}, excluding it from placement: ${outcome.reason}`,
                    { err: outcome.reason, availabilityDomain },
                );
                return;
            }
            if (!outcome.value || outcome.value.length === 0) {
                ctx.logger.warn(
                    `[oracle] No fault domains returned for availability domain ${availabilityDomain}, excluding it from placement`,
                );
                return;
            }
            faultDomainsByAD[availabilityDomain] = outcome.value;
        });

        return faultDomainsByAD;
    }

    // count total number of fault domains
    calcMaxRetries(faultDomains: FaultDomainMap): number {
        return Object.keys(faultDomains).reduce((acc, cur) => acc + (faultDomains[cur] || []).length, 0);
    }

    /**
     * Launches a single instance, retrying in the next fault/availability domain while OCI
     * reports it is out of host capacity. Never rejects: any error resolves to `false`.
     */
    async launchOracleInstance(
        ctx: Context,
        index: number,
        group: InstanceGroup,
        groupCurrentCount: number,
        availabilityDomains: string[],
        faultDomains: FaultDomainMap,
    ): Promise<string | boolean> {
        const groupName = group.name;
        try {
            // allow one retry per AD/FD
            const maxRetries = this.calcMaxRetries(faultDomains);
            const groupInstanceConfigurationId = group.instanceConfigurationId;

            const displayName = groupName + '-' + AbstractCloudInstanceManager.makeRandomString(5);
            const freeformTags = {
                group: groupName,
            };

            for (let retries = 0; ; retries++) {
                // for each retry, attempt to launch in the next FD, then the next AD
                const placement = selectPlacement(index, groupCurrentCount, retries, availabilityDomains, faultDomains);
                if (!placement) {
                    ctx.logger.error(
                        `[oracle] No availability/fault domain available for instance number ${
                            index + 1
                        } in group ${groupName}`,
                        { availabilityDomains, faultDomains },
                    );
                    return false;
                }
                const { availabilityDomain, faultDomain } = placement;

                const overwriteLaunchDetails: core.models.InstanceConfigurationLaunchInstanceDetails = {
                        availabilityDomain: availabilityDomain,
                        displayName: displayName,
                        freeformTags: freeformTags,
                    },
                    overwriteComputeInstanceDetails: core.models.ComputeInstanceDetails = {
                        launchDetails: overwriteLaunchDetails,
                        instanceType: 'compute',
                    };

                ctx.logger.info(
                    `[oracle] Launching instance number ${index + 1} in group ${groupName} with properties`,
                    {
                        groupName,
                        availabilityDomain,
                        faultDomain,
                        retries,
                        displayName,
                        groupInstanceConfigurationId,
                        overwriteComputeInstanceDetails,
                    },
                );

                if (this.isDryRun) {
                    ctx.logger.info(`[oracle] Dry run enabled, skipping the instance number ${index + 1} launch`);
                    return true;
                }
                try {
                    // A fresh retry token per attempt: a deliberate re-send of this exact request
                    // (same placement, same token) is idempotent on the OCI side, while the next
                    // placement attempt is a distinct request and must carry a distinct token.
                    const opcRetryToken = randomUUID();
                    const launchResponse = await this.withTimeout(
                        this.getComputeManagementClient(group.region).launchInstanceConfiguration({
                            instanceConfigurationId: groupInstanceConfigurationId,
                            instanceConfiguration: overwriteComputeInstanceDetails,
                            opcRetryToken,
                        }),
                        this.requestTimeoutMs,
                        `launchInstanceConfiguration for instance number ${index + 1} in group ${groupName} in region ${
                            group.region
                        }`,
                    );
                    ctx.logger.info(
                        `[oracle] Got launch response for instance number ${index + 1} in group ${groupName}`,
                        launchResponse,
                    );

                    return launchResponse.instance.id;
                } catch (err) {
                    if (OracleInstanceManager.isTimeoutError(err)) {
                        // The request may well have reached OCI and created the instance; we just
                        // never received its id. Do not retry in another domain: that would create
                        // a second instance. The instance stays untracked until its sidecar reports.
                        ctx.logger.error(
                            `[oracle] Launch of instance number ${
                                index + 1
                            } in group ${groupName} (${displayName}) timed out after ${
                                this.requestTimeoutMs
                            }ms; the instance may have been created and is untracked until its sidecar reports: ${err}`,
                            { err, displayName, availabilityDomain, faultDomain },
                        );
                        return false;
                    }
                    if (String(err).includes('Out of host capacity') && retries < maxRetries) {
                        ctx.logger.warn(
                            `[oracle] Out of host capacity in ${availabilityDomain}/${faultDomain} for instance number ${
                                index + 1
                            } in group ${groupName}, retrying in the next domain (retry ${
                                retries + 1
                            } of ${maxRetries})`,
                        );
                        continue;
                    }
                    ctx.logger.error(
                        `[oracle] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
                        { err, availabilityDomain, faultDomain },
                    );
                    return false;
                }
            }
        } catch (err) {
            ctx.logger.error(
                `[oracle] Unexpected error launching instance number ${index + 1} in group ${groupName}: ${err}`,
                { err },
            );
            return false;
        }
    }

    //TODO in the future, the list of ADs/FDs per region will be loaded once at startup time
    private async getAvailabilityDomains(group: InstanceGroup): Promise<string[]> {
        const availabilityDomainsResponse: identity.responses.ListAvailabilityDomainsResponse = await this.withTimeout(
            this.getIdentityClient(group.region).listAvailabilityDomains({
                compartmentId: group.compartmentId,
            }),
            this.requestTimeoutMs,
            `listAvailabilityDomains for group ${group.name} in region ${group.region}`,
        );
        return availabilityDomainsResponse.items.map((adResponse) => {
            return adResponse.name;
        });
    }

    private async getFaultDomains(group: InstanceGroup, availabilityDomain: string): Promise<string[]> {
        const faultDomainsResponse: identity.responses.ListFaultDomainsResponse = await this.withTimeout(
            this.getIdentityClient(group.region).listFaultDomains({
                compartmentId: group.compartmentId,
                availabilityDomain: availabilityDomain,
            }),
            this.requestTimeoutMs,
            `listFaultDomains (${availabilityDomain}) for group ${group.name} in region ${group.region}`,
        );
        return faultDomainsResponse.items.map((fdResponse) => {
            return fdResponse.name;
        });
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<CloudInstance[]> {
        const instances = <resourceSearch.models.ResourceSummary[]>[];

        const resourceSearchClient = new ResourceSearchClient(
            {
                authenticationDetailsProvider: this.provider,
            },
            this.clientConfiguration({
                terminationStrategy: new common.MaxTimeTerminationStrategy(cloudRetryStrategy.maxTimeInSeconds),
                delayStrategy: new ExponentialBackoffDelayStrategyWithJitter(cloudRetryStrategy.maxDelayInSeconds),
                retryCondition: (response) => {
                    return (
                        cloudRetryStrategy.retryableStatusCodes.filter((retryableStatusCode) => {
                            return response.statusCode === retryableStatusCode;
                        }).length > 0
                    );
                },
            }),
        );
        resourceSearchClient.regionId = group.region;

        const structuredSearch: resourceSearch.models.StructuredSearchDetails = {
            query: `query instance resources where (freeformTags.key = 'group' && freeformTags.value = '${escapeOciQueryLiteral(
                group.name,
            )}')`,
            type: 'Structured',
            matchingContextType: resourceSearch.models.SearchDetails.MatchingContextType.None,
        };

        // The SDK retries inside a single searchResources call for up to maxTimeInSeconds, so the
        // wall-clock bound for one call is that retry window plus one request timeout for the
        // final attempt. Without it a hung search would stall the sanity job indefinitely.
        const searchTimeoutMs = cloudRetryStrategy.maxTimeInSeconds * 1000 + this.requestTimeoutMs;

        // the search API pages results; keep following opcNextPage until it is exhausted
        let page: string | undefined = undefined;
        let pages = 0;
        do {
            const structuredSearchRequest: resourceSearch.requests.SearchResourcesRequest = {
                searchDetails: structuredSearch,
                limit: OCI_SEARCH_PAGE_LIMIT,
                page,
            };
            const searchResourcesResponse: resourceSearch.responses.SearchResourcesResponse = await this.withTimeout(
                resourceSearchClient.searchResources(structuredSearchRequest),
                searchTimeoutMs,
                `searchResources (page ${pages + 1}) for group ${group.name} in region ${group.region}`,
            );
            pages++;
            const items = searchResourcesResponse.resourceSummaryCollection?.items ?? [];
            for (const resourceSummary of items) {
                ctx.logger.debug('Found instance in oracle', { resourceSummary });
                instances.push(resourceSummary);
            }
            page = searchResourcesResponse.opcNextPage || undefined;
            if (page && pages >= OCI_SEARCH_MAX_PAGES) {
                ctx.logger.warn(
                    `[oracle] Stopped paging instance search for group ${group.name} after ${pages} pages, results may be incomplete`,
                );
                page = undefined;
            }
        } while (page);

        return instances.map((resourceSummary) => {
            return {
                instanceId: resourceSummary.identifier,
                displayName: resourceSummary.displayName,
                cloudStatus: resourceSummary.lifecycleState,
            };
        });
    }
}
