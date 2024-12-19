import { Context } from './context';
import GroupReportGenerator from './group_report';
import CloudManager, { CloudInstance, CloudRetryStrategy } from './cloud_manager';
import InstanceGroupManager from './instance_group';
import InstanceStore, { InstanceGroup } from './instance_store';
import MetricsStore from './metrics_store';
import AutoscalerLock, { AutoscalerLockManager } from './lock';

export interface SanityLoopOptions {
    lockManager: AutoscalerLockManager;
    metricsStore: MetricsStore;
    instanceStore: InstanceStore;
    cloudManager: CloudManager;
    reportExtCallRetryStrategy: CloudRetryStrategy;
    groupReportGenerator: GroupReportGenerator;
    instanceGroupManager: InstanceGroupManager;
}

export default class SanityLoop {
    private lockManager: AutoscalerLockManager;
    private cloudManager: CloudManager;
    private reportExtCallRetryStrategy: CloudRetryStrategy;
    private groupReportGenerator: GroupReportGenerator;
    private instanceGroupManager: InstanceGroupManager;
    private metricsStore: MetricsStore;
    private instanceStore: InstanceStore;

    constructor(options: SanityLoopOptions) {
        this.lockManager = options.lockManager;
        this.cloudManager = options.cloudManager;
        this.reportExtCallRetryStrategy = options.reportExtCallRetryStrategy;
        this.groupReportGenerator = options.groupReportGenerator;
        this.instanceGroupManager = options.instanceGroupManager;
        this.metricsStore = options.metricsStore;
        this.instanceStore = options.instanceStore;

        this.reportUntrackedInstances = this.reportUntrackedInstances.bind(this);
    }

    async reportUntrackedInstances(ctx: Context, groupName: string): Promise<boolean> {
        let lock: AutoscalerLock = undefined;
        try {
            lock = await this.lockManager.lockGroup(ctx, `${groupName}-sanity`);
        } catch (err) {
            ctx.logger.warn(`[Sanity] Error obtaining lock for processing`, { err });
            return false;
        }
        try {
            const group: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(ctx, groupName);
            if (group) {
                const sanityAllowed = await this.instanceGroupManager.allowSanity(ctx, group.name);
                if (!sanityAllowed) {
                    ctx.logger.info(`[Sanity] Wait before querying cloud provider for group ${group.name}`);
                    return false;
                }

                const cloudStart = process.hrtime();
                ctx.logger.info(`Retrieving ${group.cloud} instances for ${groupName}`);
                const cloudInstances = await this.cloudManager.getInstances(
                    ctx,
                    group,
                    this.reportExtCallRetryStrategy,
                );
                const cloudDelta = process.hrtime(cloudStart);
                const cloudInstancesSize = cloudInstances ? cloudInstances.length : 0;
                ctx.logger.info(
                    `Successfully retrieved ${cloudInstancesSize} ${group.cloud} instances for ${groupName} in ${
                        cloudDelta[0] * 1000 + cloudDelta[1] / 1000000
                    } ms`,
                );
                ctx.logger.debug(`Retrieved ${group.cloud} instance details for ${groupName}`, { cloudInstances });
                await this.saveCloudInstances(ctx, group.name, cloudInstances);

                const groupReportStart = process.hrtime();
                const groupReport = await this.groupReportGenerator.generateReport(ctx, group, cloudInstances);
                const groupReportEnd = process.hrtime(groupReportStart);
                ctx.logger.info(
                    `Retrieved group report in ${groupReportEnd[0] * 1000 + groupReportEnd[1] / 1000000} ms`,
                );

                await this.saveMetricUnTrackedCount(ctx, groupName, groupReport.unTrackedCount);
                ctx.logger.info(
                    `Successfully saved cloud instances and untracked count ${groupReport.unTrackedCount} for ${groupName}`,
                );
                await this.instanceGroupManager.setSanityGracePeriod(ctx, group);
                return true;
            } else {
                ctx.logger.info(`Skipped saving untracked instances, as group is not found ${groupName}`);
                return false;
            }
        } catch (err) {
            ctx.logger.error(`Error processing sanity check for group ${groupName}`, err);
            return false;
        } finally {
            if (lock) {
                await lock.release(ctx);
            }
        }
    }

    async saveMetricUnTrackedCount(ctx: Context, groupName: string, count: number): Promise<boolean> {
        return this.metricsStore.saveMetricUnTrackedCount(ctx, groupName, count);
    }

    private async saveCloudInstances(ctx: Context, groupName: string, cloudInstances: CloudInstance[]) {
        return this.instanceStore.saveCloudInstances(ctx, groupName, cloudInstances);
    }
}
