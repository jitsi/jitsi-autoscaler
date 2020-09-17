import { InstanceState, InstanceTracker, JibriStatusState } from './instance_tracker';
import { Context } from './context';
import { InstanceGroup } from './instance_group';
import { CloudInstance } from './cloud_manager';
import ShutdownManager from './shutdown_manager';
import MetricsLoop from './metrics_loop';

export interface InstanceReport {
    instanceId: string;
    displayName?: string;
    instanceName?: string;
    scaleStatus?: string;
    cloudStatus?: string;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
    privateIp?: string;
    publicIp?: string;
    version?: string;
}

export interface GroupReport {
    groupName: string;
    count?: number;
    desiredCount?: number;
    provisioningCount?: number;
    availableCount?: number;
    busyCount?: number;
    expiredCount?: number;
    cloudCount?: number;
    unTrackedCount?: number;
    shuttingDownCount?: number;
    scaleDownProtectedCount?: number;
    instances?: Array<InstanceReport>;
}

export interface GroupReportGeneratorOptions {
    instanceTracker: InstanceTracker;
    shutdownManager: ShutdownManager;
    metricsLoop: MetricsLoop;
}

export default class GroupReportGenerator {
    private instanceTracker: InstanceTracker;
    private shutdownManager: ShutdownManager;
    private metricsLoop: MetricsLoop;

    constructor(options: GroupReportGeneratorOptions) {
        this.instanceTracker = options.instanceTracker;
        this.shutdownManager = options.shutdownManager;
        this.metricsLoop = options.metricsLoop;

        this.generateReport = this.generateReport.bind(this);
    }

    async generateReport(ctx: Context, group: InstanceGroup): Promise<GroupReport> {
        if (!group) {
            throw new Error(`Group not found, failed to generate report`);
        }
        if (!group.type) {
            throw new Error('Only typed groups are supported for report generation');
        }
        const groupName = group.name;

        const groupReport: GroupReport = {
            groupName: groupName,
            desiredCount: group.scalingOptions.desiredCount,
            count: 0,
            cloudCount: 0,
            provisioningCount: 0,
            availableCount: 0,
            busyCount: 0,
            expiredCount: 0,
            unTrackedCount: 0,
            shuttingDownCount: 0,
            scaleDownProtectedCount: 0,
            instances: [],
        };

        // Get the list of instances from redis and from the cloud manager
        const instanceStates = await this.instanceTracker.getCurrent(ctx, groupName, false);
        groupReport.count = instanceStates.length;
        const cloudInstances: CloudInstance[] = await this.metricsLoop.getCloudInstances(group.name);

        this.getInstanceReportsMap(group, instanceStates, cloudInstances).forEach((instanceReport) => {
            groupReport.instances.push(instanceReport);
        });

        await this.addShutdownStatus(ctx, groupReport.instances);
        await this.addShutdownProtectedStatus(ctx, groupReport.instances);

        groupReport.instances.forEach((instanceReport) => {
            if (instanceReport.cloudStatus === 'Provisioning' || instanceReport.cloudStatus === 'Running') {
                groupReport.cloudCount++;
            }
            if (instanceReport.isShuttingDown) {
                groupReport.shuttingDownCount++;
            }
            if (instanceReport.isScaleDownProtected) {
                groupReport.scaleDownProtectedCount++;
            }
            if (
                instanceReport.scaleStatus == 'unknown' &&
                (instanceReport.cloudStatus === 'Provisioning' || instanceReport.cloudStatus === 'Running')
            ) {
                groupReport.unTrackedCount++;
            }
            if (instanceReport.scaleStatus == 'PROVISIONING') {
                groupReport.provisioningCount++;
            }
            switch (group.type) {
                case 'jibri':
                    if (instanceReport.scaleStatus == JibriStatusState.Idle) {
                        groupReport.availableCount++;
                    }
                    if (instanceReport.scaleStatus == JibriStatusState.Busy) {
                        groupReport.busyCount++;
                    }
                    if (instanceReport.scaleStatus == JibriStatusState.Expired) {
                        groupReport.expiredCount++;
                    }
                    break;
                case 'JVB':
                    // @TODO: implement JVB instance counting
                    break;
            }
        });

        return groupReport;
    }

    private getInstanceReportsMap(
        group: InstanceGroup,
        instanceStates: Array<InstanceState>,
        cloudInstances: Array<CloudInstance>,
    ): Map<string, InstanceReport> {
        const instanceReports = new Map<string, InstanceReport>();

        instanceStates.forEach((instanceState) => {
            const instanceReport = <InstanceReport>{
                instanceId: instanceState.instanceId,
                displayName: 'unknown',
                instanceName: 'unknown',
                scaleStatus: 'unknown',
                cloudStatus: 'unknown',
                version: 'unknown',
                isShuttingDown: instanceState.shutdownStatus,
                isScaleDownProtected: false,
            };
            if (instanceState.shutdownStatus) {
                instanceReport.scaleStatus = 'SHUTDOWN';
            } else if (instanceState.status.provisioning) {
                instanceReport.scaleStatus = 'PROVISIONING';
            } else {
                switch (group.type) {
                    case 'jibri':
                        if (instanceState.status.jibriStatus && instanceState.status.jibriStatus.busyStatus) {
                            instanceReport.scaleStatus = instanceState.status.jibriStatus.busyStatus.toString();
                        }
                        break;
                    case 'JVB':
                        // @TODO: convert JVB stats into more explict statuses
                        instanceReport.scaleStatus = 'ONLINE';
                        if (instanceState.status.jvbStatus && instanceState.status.jvbStatus.participants) {
                            instanceReport.scaleStatus = 'IN USE';
                        }
                        if (instanceState.status.jvbStatus && instanceState.status.jvbStatus.graceful_shutdown) {
                            instanceReport.scaleStatus = 'GRACEFUL SHUTDOWN';
                        }
                        break;
                }
            }
            if (instanceState.metadata.name) {
                instanceReport.instanceName = instanceState.metadata.name;
            }
            if (instanceState.metadata.publicIp) {
                instanceReport.publicIp = instanceState.metadata.publicIp;
            }
            if (instanceState.metadata.privateIp) {
                instanceReport.privateIp = instanceState.metadata.privateIp;
            }
            if (instanceState.metadata.version) {
                instanceReport.version = instanceState.metadata.version;
            }
            instanceReports.set(instanceState.instanceId, instanceReport);
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

    private async addShutdownStatus(ctx: Context, instanceReports: Array<InstanceReport>): Promise<void> {
        const instanceReportsShutdownStatus: boolean[] = await Promise.all(
            instanceReports.map((instanceReport) => {
                return (
                    instanceReport.isShuttingDown ||
                    this.shutdownManager.getShutdownStatus(ctx, instanceReport.instanceId)
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
