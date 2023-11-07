import { Context } from './context';
import GroupReportGenerator from './group_report';
import CloudManager, { CloudInstance, CloudRetryStrategy } from './cloud_manager';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import { Redis } from 'ioredis';

export interface SanityLoopOptions {
    redisClient: Redis;
    metricsTTL: number;
    cloudManager: CloudManager;
    reportExtCallRetryStrategy: CloudRetryStrategy;
    groupReportGenerator: GroupReportGenerator;
    instanceGroupManager: InstanceGroupManager;
}

export default class SanityLoop {
    private cloudManager: CloudManager;
    private reportExtCallRetryStrategy: CloudRetryStrategy;
    private groupReportGenerator: GroupReportGenerator;
    private instanceGroupManager: InstanceGroupManager;
    private redisClient: Redis;
    private metricsTTL: number;

    constructor(options: SanityLoopOptions) {
        this.cloudManager = options.cloudManager;
        this.reportExtCallRetryStrategy = options.reportExtCallRetryStrategy;
        this.groupReportGenerator = options.groupReportGenerator;
        this.instanceGroupManager = options.instanceGroupManager;
        this.redisClient = options.redisClient;
        this.metricsTTL = options.metricsTTL;

        this.reportUntrackedInstances = this.reportUntrackedInstances.bind(this);
    }

    async reportUntrackedInstances(ctx: Context, groupName: string): Promise<boolean> {
        const group: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(groupName);
        if (group) {
            const cloudStart = process.hrtime();
            ctx.logger.info(`Retrieving ${group.cloud} instances for ${groupName}`);
            const cloudInstances = await this.cloudManager.getInstances(ctx, group, this.reportExtCallRetryStrategy);
            const cloudDelta = process.hrtime(cloudStart);
            const cloudInstancesSize = cloudInstances ? cloudInstances.length : 0;
            ctx.logger.info(
                `Successfully retrieved ${cloudInstancesSize} ${group.cloud} instances for ${groupName} in ${
                    cloudDelta[0] * 1000 + cloudDelta[1] / 1000000
                } ms`,
            );

            await this.saveCloudInstances(group.name, cloudInstances);

            const groupReportStart = process.hrtime();
            const groupReport = await this.groupReportGenerator.generateReport(ctx, group, cloudInstances);
            const groupReportEnd = process.hrtime(groupReportStart);
            ctx.logger.info(`Retrieved group report in ${groupReportEnd[0] * 1000 + groupReportEnd[1] / 1000000} ms`);

            await this.saveMetricUnTrackedCount(groupName, groupReport.unTrackedCount);
            ctx.logger.info(
                `Successfully saved cloud instances and untracked count ${groupReport.unTrackedCount} for ${groupName}`,
            );
            return true;
        } else {
            ctx.logger.info(`Skipped saving untracked instances, as group is not found ${groupName}`);
            return false;
        }
    }

    async saveMetricUnTrackedCount(groupName: string, count: number): Promise<boolean> {
        const key = `service-metrics:${groupName}:untracked-count`;
        const result = await this.redisClient.set(key, JSON.stringify(count), 'EX', this.metricsTTL);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    private async saveCloudInstances(groupName: string, cloudInstances: Array<CloudInstance>) {
        await this.redisClient.set(
            `cloud-instances-list:${groupName}`,
            JSON.stringify(cloudInstances),
            'EX',
            this.metricsTTL,
        );
    }
}
