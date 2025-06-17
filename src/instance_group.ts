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
    }

    async init(ctx: Context): Promise<void> {
        ctx.logger.info('Initializing instance group manager...');
        const existsAtLeastOneGroup = await this.existsAtLeastOneGroup(ctx);
        if (!existsAtLeastOneGroup) {
            ctx.logger.info('Storing instance groups into instance store');
            await Promise.all(this.initialGroupList.map((group) => this.upsertInstanceGroup(ctx, group)));
            ctx.logger.info('Stored instance groups into instance store');
        }
    }

    getInitialGroups(): InstanceGroup[] {
        return this.initialGroupList;
    }

    async existsAtLeastOneGroup(ctx: Context): Promise<boolean> {
        return this.instanceStore.existsAtLeastOneGroup(ctx);
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

    // only allow autoscaling if the autoscale grace period has expired
    async allowAutoscaling(ctx: Context, group: string): Promise<boolean> {
        return !(await this.instanceStore.checkValue(ctx, `autoScaleGracePeriod:${group}`));
    }

    async allowSanity(ctx: Context, group: string): Promise<boolean> {
        return this.instanceStore.checkValue(ctx, `sanityGracePeriod:${group}`);
    }

    async setAutoScaleGracePeriod(ctx: Context, group: InstanceGroup): Promise<boolean> {
        ctx.logger.info(`resetting autoscale grace period for group ${group.name}: ${group.gracePeriodTTLSec}`, {
            gracePeriodTTLSec: group.gracePeriodTTLSec,
        });
        return this.setValue(ctx, `autoScaleGracePeriod:${group.name}`, group.gracePeriodTTLSec);
    }

    async setSanityGracePeriod(ctx: Context, group: InstanceGroup): Promise<boolean> {
        ctx.logger.info(`resetting sanity grace period for group ${group.name}: ${this.sanityJobsIntervalSeconds}`, {
            sanityJobsIntervalSeconds: this.sanityJobsIntervalSeconds,
        });
        return this.setValue(ctx, `sanityGracePeriod:${group.name}`, this.sanityJobsIntervalSeconds);
    }

    async setScaleDownProtected(ctx: Context, group: InstanceGroup): Promise<boolean> {
        return this.setValue(ctx, `isScaleDownProtected:${group.name}`, group.protectedTTLSec);
    }

    // only show scale protection if value is set
    async isScaleDownProtected(ctx: Context, group: string): Promise<boolean> {
        return this.instanceStore.checkValue(ctx, `isScaleDownProtected:${group}`);
    }

    // only allow group jobs if the grace period has expired
    async isGroupJobsCreationAllowed(ctx: Context): Promise<boolean> {
        return !(await this.instanceStore.checkValue(ctx, 'groupJobsCreationGracePeriod'));
    }

    async setGroupJobsCreationGracePeriod(ctx: Context): Promise<boolean> {
        return this.setValue(ctx, `groupJobsCreationGracePeriod`, this.processingIntervalSeconds);
    }

    // only allow sanity jobs if the grace period has expired
    async isSanityJobsCreationAllowed(ctx: Context): Promise<boolean> {
        return !(await this.instanceStore.checkValue(ctx, 'sanityJobsCreationGracePeriod'));
    }

    async setSanityJobsCreationGracePeriod(ctx: Context): Promise<boolean> {
        return this.setValue(ctx, `sanityJobsCreationGracePeriod`, this.sanityJobsIntervalSeconds);
    }

    async setValue(ctx: Context, key: string, ttl: number): Promise<boolean> {
        return this.instanceStore.setValue(ctx, key, 'false', ttl);
    }
}
