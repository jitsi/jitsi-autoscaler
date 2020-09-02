import { JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';
import { Context } from './context';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import CloudManager, { CloudInstance, CloudRetryStrategy } from './cloud_manager';
import ShutdownManager from './shutdown_manager';

export interface InstanceReport {
    instanceId: string;
    displayName?: string;
    scaleStatus?: string;
    cloudStatus?: string;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
}

export interface GroupReport {
    groupName: string;
    count?: number;
    desiredCount?: number;
    provisioningCount?: number;
    availableCount?: number;
    busyCount?: number;
    cloudCount?: number;
    unTrackedCount?: number;
    shuttingDownCount?: number;
    scaleDownProtectedCount?: number;
    instances?: Array<InstanceReport>;
}

export interface GroupReportGeneratorOptions {
    jibriTracker: JibriTracker;
    instanceGroupManager: InstanceGroupManager;
    cloudManager: CloudManager;
    shutdownManager: ShutdownManager;
    reportExtCallRetryStrategy: CloudRetryStrategy;
}

export default class GroupReportGenerator {
    private jibriTracker: JibriTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private shutdownManager: ShutdownManager;
    private reportExtCallRetryStrategy: CloudRetryStrategy;

    constructor(options: GroupReportGeneratorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.instanceGroupManager = options.instanceGroupManager;
        this.cloudManager = options.cloudManager;
        this.shutdownManager = options.shutdownManager;
        this.reportExtCallRetryStrategy = options.reportExtCallRetryStrategy;

        this.generateReport = this.generateReport.bind(this);
    }

    async generateReport(ctx: Context, groupName: string): Promise<GroupReport> {
        const group: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(groupName);
        if (group.type != 'jibri') {
            throw new Error('Only jibri groups are supported');
        }

        const groupReport: GroupReport = {
            groupName: groupName,
            desiredCount: group.scalingOptions.desiredCount,
            count: 0,
            provisioningCount: 0,
            availableCount: 0,
            busyCount: 0,
            cloudCount: 0,
            unTrackedCount: 0,
            shuttingDownCount: 0,
            scaleDownProtectedCount: 0,
            instances: [],
        };

        // Get the list of instances from redis and from the cloud manager
        const jibriStates = await this.jibriTracker.getCurrent(ctx, groupName);
        groupReport.count = jibriStates.length;
        const cloudInstances = await this.cloudManager.getInstances(ctx, group, this.reportExtCallRetryStrategy);
        groupReport.cloudCount = cloudInstances.length;
        this.getInstanceReportsMap(jibriStates, cloudInstances).forEach((instanceReport) => {
            groupReport.instances.push(instanceReport);
        });

        await this.addShutdownStatus(ctx, groupReport.instances, 'jibri');
        await this.addShutdownProtectedStatus(ctx, groupReport.instances);

        groupReport.instances.forEach((instanceReport) => {
            if (instanceReport.isShuttingDown) {
                groupReport.shuttingDownCount++;
            }
            if (instanceReport.isScaleDownProtected) {
                groupReport.scaleDownProtectedCount++;
            }
            if (instanceReport.scaleStatus == 'unknown') {
                groupReport.unTrackedCount++;
            }
            if (instanceReport.scaleStatus == JibriStatusState.Provisioning) {
                groupReport.provisioningCount++;
            }
            if (instanceReport.scaleStatus == JibriStatusState.Idle) {
                groupReport.availableCount++;
            }
            if (instanceReport.scaleStatus == JibriStatusState.Busy) {
                groupReport.busyCount++;
            }
        });

        return groupReport;
    }

    private getInstanceReportsMap(
        jibriStates: Array<JibriState>,
        cloudInstances: Array<CloudInstance>,
    ): Map<string, InstanceReport> {
        const instanceReports = new Map<string, InstanceReport>();

        jibriStates.forEach((jibriState) => {
            const instanceReport = {
                instanceId: jibriState.jibriId,
                displayName: 'unknown',
                scaleStatus: jibriState.status.busyStatus.toString(),
                cloudStatus: 'unknown',
                isShuttingDown: jibriState.shutdownStatus,
                isScaleDownProtected: false,
            };
            instanceReports.set(jibriState.jibriId, instanceReport);
        });

        cloudInstances.forEach((cloudInstance) => {
            let instanceReport = instanceReports.get(cloudInstance.instanceId);
            if (!instanceReport) {
                instanceReport = {
                    instanceId: cloudInstance.instanceId,
                    displayName: cloudInstance.displayName,
                    scaleStatus: 'unknown',
                    cloudStatus: cloudInstance.cloudStatus,
                    isShuttingDown: false,
                    isScaleDownProtected: false,
                };
            } else {
                instanceReport.displayName = cloudInstance.displayName;
                instanceReport.cloudStatus = cloudInstance.cloudStatus;
            }
            instanceReports.set(cloudInstance.instanceId, instanceReport);
        });

        return instanceReports;
    }

    private async addShutdownStatus(
        ctx: Context,
        instanceReports: Array<InstanceReport>,
        instanceType: string,
    ): Promise<void> {
        const instanceReportsShutdownStatus: boolean[] = await Promise.all(
            instanceReports.map((instanceReport) => {
                return (
                    instanceReport.isShuttingDown ||
                    this.shutdownManager.getShutdownStatus(ctx, {
                        instanceId: instanceReport.instanceId,
                        instanceType: instanceType,
                    })
                );
            }),
        );
        instanceReports.forEach((instanceReport, index) => {
            instanceReport.isShuttingDown = instanceReportsShutdownStatus[index];
        });
    }

    private async addShutdownProtectedStatus(ctx: Context, instanceReports: Array<InstanceReport>): Promise<void> {
        const instanceReportsShutdownStatus: boolean[] = await Promise.all(
            instanceReports.map((instanceReport) => {
                return this.shutdownManager.isScaleDownProtected(ctx, instanceReport.instanceId);
            }),
        );
        instanceReports.forEach((instanceReport, index) => {
            instanceReport.isScaleDownProtected = instanceReportsShutdownStatus[index];
        });
    }
}
