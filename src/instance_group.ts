import { Context } from './context';
import InstanceStore, { InstanceGroup, InstanceGroupTags } from './instance_store';

export interface InstanceGroupManagerOptions {
    instanceStore: InstanceStore;
    initialGroupList: InstanceGroup[];
    groupJobsCreationGracePeriod: number;
    sanityJobsCreationGracePeriod: number;
}

export default class InstanceGroupManager {
    private instanceStore: InstanceStore;
    private readonly initialGroupList: InstanceGroup[];
    private readonly processingIntervalSeconds: number;
    private readonly sanityJobsIntervalSeconds: number;

    constructor(options: InstanceGroupManagerOptions) {
        this.instanceStore = options.instanceStore;
        this.initialGroupList = options.initialGroupList;
        this.processingIntervalSeconds = options.groupJobsCreationGracePeriod;
        this.sanityJobsIntervalSeconds = options.sanityJobsCreationGracePeriod;

        this.init = this.init.bind(this);
        this.getInstanceGroup = this.getInstanceGroup.bind(this);
        this.getAllInstanceGroupNames = this.getAllInstanceGroupNames.bind(this);
        this.getAllInstanceGroups = this.getAllInstanceGroups.bind(this);
        this.upsertInstanceGroup = this.upsertInstanceGroup.bind(this);
        this.existsAtLeastOneGroup = this.existsAtLeastOneGroup.bind(this);
    }

    async init(ctx: Context): Promise<void> {
        ctx.logger.info('Initializing instance group manager...');
        const existsAtLeastOneGroup = await this.existsAtLeastOneGroup();
        if (!existsAtLeastOneGroup) {
            ctx.logger.info('Storing instance groups into instance store');
            await Promise.all(this.initialGroupList.map((group) => this.upsertInstanceGroup(ctx, group)));
            ctx.logger.info('Stored instance groups into instance store');
        }
    }

    getInitialGroups(): InstanceGroup[] {
        return this.initialGroupList;
    }

    async existsAtLeastOneGroup(): Promise<boolean> {
        return this.instanceStore.existsAtLeastOneGroup();
    }

    async upsertInstanceGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        return this.instanceStore.upsertInstanceGroup(ctx, group);
    }

    async getInstanceGroup(ctx: Context, groupName: string): Promise<InstanceGroup> {
        return this.instanceStore.getInstanceGroup(ctx, groupName);
    }

    async getAllInstanceGroupsAsMap(ctx: Context): Promise<Map<string, InstanceGroup>> {
        const groups = await this.getAllInstanceGroups(ctx);
        return groups.reduce((map: Map<string, InstanceGroup>, group: InstanceGroup) => {
            map.set(group.name, group);
            return map;
        }, new Map<string, InstanceGroup>());
    }

    async getAllInstanceGroupsByTypeRegionEnvironment(
        ctx: Context,
        type: string,
        region: string,
        environment: string,
    ): Promise<InstanceGroup[]> {
        const groups = await this.getAllInstanceGroups(ctx);

        function byTypeRegionEnvironment(group: InstanceGroup) {
            return (
                group.type.toLowerCase() == type.toLowerCase() &&
                group.region.toLowerCase() == region.toLowerCase() &&
                group.environment.toLowerCase() == environment.toLowerCase()
            );
        }

        const instanceGroups = groups.filter(byTypeRegionEnvironment);
        ctx.logger.info(
            `Found ${instanceGroups.length} groups environment ${environment} of type ${type} in region ${region}`,
        );
        return instanceGroups;
    }

    async getAllInstanceGroupNames(ctx: Context): Promise<string[]> {
        return this.instanceStore.getAllInstanceGroupNames(ctx);
    }

    async getAllInstanceGroups(ctx: Context): Promise<InstanceGroup[]> {
        return this.instanceStore.getAllInstanceGroups(ctx);
    }

    async getAllInstanceGroupsFiltered(ctx: Context, expectedTags: InstanceGroupTags): Promise<InstanceGroup[]> {
        const allGroups = await this.getAllInstanceGroups(ctx);

        const filteredGroups = allGroups.filter((group) => InstanceGroupManager.filterGroups(ctx, group, expectedTags));
        ctx.logger.info(`Found groups with tags: ${filteredGroups.length} `, { expectedTags });
        return filteredGroups;
    }

    private static filterGroups(ctx: Context, group: InstanceGroup, expectedTags: InstanceGroupTags): boolean {
        if (!expectedTags || Object.keys(expectedTags).length == 0) {
            return true;
        }

        if (!group.tags) {
            ctx.logger.debug(`Skipping group as it has no tags, for group ${group.name}`);
            return false;
        }

        for (const expectedTagName in expectedTags) {
            const expectedTagValue = expectedTags[expectedTagName];

            if (!group.tags[expectedTagName] || !(group.tags[expectedTagName] === expectedTagValue)) {
                ctx.logger.debug(
                    `Skipping group due to invalid or missing tag, for group ${group.name}, expected tag key: ${expectedTagName}, expected value: ${expectedTagValue}, actual value: ${group.tags[expectedTagName]}`,
                    { tags: group.tags },
                );
                return false;
            }
        }

        return true;
    }

    async deleteInstanceGroup(ctx: Context, groupName: string): Promise<void> {
        await this.instanceStore.deleteInstanceGroup(ctx, groupName);
    }

    async allowAutoscaling(ctx: Context, group: string): Promise<boolean> {
        return this.instanceStore.checkValue(`autoScaleGracePeriod:${group}`);
    }

    async setAutoScaleGracePeriod(ctx: Context, group: InstanceGroup): Promise<boolean> {
        ctx.logger.info(`resetting autoscale grace period for group ${group.name}: ${group.gracePeriodTTLSec}`, {
            gracePeriodTTLSec: group.gracePeriodTTLSec,
        });
        return this.setValue(`autoScaleGracePeriod:${group.name}`, group.gracePeriodTTLSec);
    }

    async setScaleDownProtected(group: InstanceGroup): Promise<boolean> {
        return this.setValue(`isScaleDownProtected:${group.name}`, group.protectedTTLSec);
    }

    async isScaleDownProtected(group: string): Promise<boolean> {
        return this.instanceStore.checkValue(`isScaleDownProtected:${group}`);
    }

    async isGroupJobsCreationAllowed(): Promise<boolean> {
        return this.instanceStore.checkValue('groupJobsCreationGracePeriod');
    }

    async setGroupJobsCreationGracePeriod(): Promise<boolean> {
        return this.setValue(`groupJobsCreationGracePeriod`, this.processingIntervalSeconds);
    }

    async isSanityJobsCreationAllowed(): Promise<boolean> {
        return this.instanceStore.checkValue('sanityJobsCreationGracePeriod');
    }

    async setSanityJobsCreationGracePeriod(): Promise<boolean> {
        return this.setValue(`sanityJobsCreationGracePeriod`, this.sanityJobsIntervalSeconds);
    }

    async setValue(key: string, ttl: number): Promise<boolean> {
        return this.instanceStore.setValue(key, 'false', ttl);
    }
}
