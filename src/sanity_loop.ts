import { Context } from './context';
import GroupReportGenerator from './group_report';
import CloudManager, { CloudInstance, CloudRetryStrategy } from './cloud_manager';
import InstanceGroupManager from './instance_group';
import InstanceStore, { InstanceGroup } from './instance_store';
import MetricsStore from './metrics_store';

export interface SanityLoopOptions {
    metricsStore: MetricsStore;
    instanceStore: InstanceStore;
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
    private metricsStore: MetricsStore;
    private instanceStore: InstanceStore;

    constructor(options: SanityLoopOptions) {
        this.cloudManager = options.cloudManager;
        this.reportExtCallRetryStrategy = options.reportExtCallRetryStrategy;
        this.groupReportGenerator = options.groupReportGenerator;
        this.instanceGroupManager = options.instanceGroupManager;
        this.metricsStore = options.metricsStore;
        this.instanceStore = options.instanceStore;

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
            ctx.logger.debug(`Retrieved ${group.cloud} instance details for ${groupName}`, { cloudInstances });
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
        return this.metricsStore.saveMetricUnTrackedCount(groupName, count);
    }

    private async saveCloudInstances(groupName: string, cloudInstances: CloudInstance[]) {
        return this.instanceStore.saveCloudInstances(groupName, cloudInstances);
    }
}
