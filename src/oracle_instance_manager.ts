import core = require('oci-core');
import common = require('oci-common');
import identity = require('oci-identity');
import { InstanceGroup } from './instance_group';
import { JibriHealthState, JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';
import { Context } from './context';
import ShutdownManager from './shutdown_manager';

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
    jibriTracker: JibriTracker;
    shutdownManager: ShutdownManager;
}

export default class OracleInstanceManager {
    private isDryRun: boolean;
    private provider: common.ConfigFileAuthenticationDetailsProvider;
    private identityClient: identity.IdentityClient;
    private computeManagementClient: core.ComputeManagementClient;
    private jibriTracker: JibriTracker;
    private shutdownManager: ShutdownManager;

    constructor(options: OracleInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.jibriTracker = options.jibriTracker;
        this.provider = new common.ConfigFileAuthenticationDetailsProvider(
            options.ociConfigurationFilePath,
            options.ociConfigurationProfile,
        );
        this.identityClient = new identity.IdentityClient({ authenticationDetailsProvider: this.provider });
        this.computeManagementClient = new core.ComputeManagementClient({
            authenticationDetailsProvider: this.provider,
        });
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

        this.computeManagementClient.regionId = group.region;
        const availabilityDomains: string[] = await this.getAvailabilityDomains(group.compartmentId, group.region);

        const indexes: Array<number> = [];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        await Promise.all(
            indexes.map((index) => {
                this.launchInstance(ctx, index, group, groupCurrentCount, availabilityDomains, isScaleDownProtected);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);
    }

    async launchInstance(
        ctx: Context,
        index: number,
        group: InstanceGroup,
        groupCurrentCount: number,
        availabilityDomains: string[],
        isScaleDownProtected: boolean,
    ): Promise<void> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;
        ctx.logger.info(`[oracle] Gathering properties for launching instance ${index} in group ${groupName}`);

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

        ctx.logger.info(`[oracle] Launching instance ${index} in group ${groupName} with properties`, {
            groupName,
            availabilityDomain,
            faultDomain,
            displayName,
            groupInstanceConfigurationId,
            overwriteComputeInstanceDetails,
        });

        if (this.isDryRun) {
            ctx.logger.debug('[oracle] Dry run enabled, skipping the instance launch');
            return;
        }
        try {
            const launchResponse = await this.computeManagementClient.launchInstanceConfiguration({
                instanceConfigurationId: groupInstanceConfigurationId,
                instanceConfiguration: overwriteComputeInstanceDetails,
            });
            ctx.logger.info(`[oracle] Got launch response for instance ${index} in group ${groupName}`, launchResponse);
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
            ctx.logger.error(`[oracle] Failed launching instance ${index} in group ${groupName}`, err);
        }
    }

    //TODO in the future, the list of ADs/FDs per region will be loaded once at startup time
    async getAvailabilityDomains(compartmentId: string, region: string): Promise<string[]> {
        this.identityClient.regionId = region;
        const availabilityDomainsResponse: identity.responses.ListAvailabilityDomainsResponse = await this.identityClient.listAvailabilityDomains(
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

    async getFaultDomains(compartmentId: string, region: string, availabilityDomain: string): Promise<string[]> {
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
}
