import { InstanceTracker } from './instance_tracker';
import { Context } from './context';
import { CloudInstance } from './cloud_manager';
import ShutdownManager from './shutdown_manager';
import MetricsLoop from './metrics_loop';
import ReconfigureManager from './reconfigure_manager';
import { InstanceGroup, InstanceState, JibriStatusState } from './instance_store';

export interface InstanceReport {
    instanceId: string;
    displayName?: string;
    group?: string;
    instanceName?: string;
    scaleStatus?: string;
    cloudStatus?: string;
    shutdownComplete?: string | false;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
    reconfigureScheduled?: string;
    lastReconfigured?: string;
    reconfigureError?: boolean;
    shutdownError?: boolean;
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
    shutdownCount?: number;
    shuttingDownCount?: number;
    shutdownErrorCount?: number;
    reconfigureErrorCount?: number;
    reconfigureScheduledCount?: number;
    scaleDownProtectedCount?: number;
    instances?: InstanceReport[];
}

export interface GroupReportGeneratorOptions {
    instanceTracker: InstanceTracker;
    shutdownManager: ShutdownManager;
    reconfigureManager: ReconfigureManager;
    metricsLoop: MetricsLoop;
}

export default class GroupReportGenerator {
    private instanceTracker: InstanceTracker;
    private shutdownManager: ShutdownManager;
    private reconfigureManager: ReconfigureManager;
    private metricsLoop: MetricsLoop;

    constructor(options: GroupReportGeneratorOptions) {
        this.instanceTracker = options.instanceTracker;
        this.shutdownManager = options.shutdownManager;
        this.reconfigureManager = options.reconfigureManager;
        this.metricsLoop = options.metricsLoop;

        this.generateReport = this.generateReport.bind(this);
    }

    async generateReport(
        ctx: Context,
        group: InstanceGroup,
        retrievedCloudInstances: CloudInstance[],
    ): Promise<GroupReport> {
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
            shutdownCount: 0,
            shutdownErrorCount: 0,
            reconfigureErrorCount: 0,
            reconfigureScheduledCount: 0,
            scaleDownProtectedCount: 0,
            instances: [],
        };

        // Get the list of instances from redis and from the cloud manager
        const instanceStates = await this.instanceTracker.trimCurrent(ctx, groupName, false);
        groupReport.count = instanceStates.length;

        let cloudInstances: CloudInstance[] = retrievedCloudInstances;
        if (!cloudInstances) {
            cloudInstances = await this.metricsLoop.getCloudInstances(group.name);
        }

        this.getInstanceReportsMap(group, instanceStates, cloudInstances).forEach((instanceReport) => {
            groupReport.instances.push(instanceReport);
        });

        await this.addShutdownStatus(ctx, group.name, groupReport.instances);
        await this.addShutdownConfirmations(ctx, group.name, groupReport.instances);
        await this.addReconfigureDate(ctx, group.name, groupReport.instances);
        await this.addShutdownProtectedStatus(ctx, group.name, groupReport.instances);

        groupReport.instances.forEach((instanceReport) => {
            if (this.isProvisioningOrRunningCloudInstance(instanceReport)) {
                groupReport.cloudCount++;
            }
            if (instanceReport.isShuttingDown) {
                groupReport.shuttingDownCount++;
            }
            if (instanceReport.shutdownComplete) {
                groupReport.shutdownCount++;
            }
            if (instanceReport.isScaleDownProtected) {
                groupReport.scaleDownProtectedCount++;
            }
            if (instanceReport.reconfigureError) {
                groupReport.reconfigureErrorCount++;
            }
            if (instanceReport.shutdownError) {
                groupReport.shutdownErrorCount++;
            }
            if (instanceReport.reconfigureScheduled) {
                groupReport.reconfigureScheduledCount++;
            }
            if (instanceReport.scaleStatus == 'unknown' && this.isProvisioningOrRunningCloudInstance(instanceReport)) {
                ctx.logger.info(`Adding untracked instance to group report ${groupName}: ${instanceReport.instanceId}`);
                groupReport.unTrackedCount++;
            }
            if (instanceReport.scaleStatus == 'PROVISIONING') {
                groupReport.provisioningCount++;
            }
            switch (group.type) {
                case 'jibri':
                case 'sip-jibri':
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
                case 'jigasi':
                case 'nomad':
                case 'JVB':
                    // @TODO: implement JVB instance counting
                    break;
            }
        });

        return groupReport;
    }

    private isProvisioningOrRunningCloudInstance(instanceReport: InstanceReport): boolean {
        return (
            instanceReport &&
            instanceReport.cloudStatus &&
            (instanceReport.cloudStatus.toUpperCase() === 'PROVISIONING' ||
                instanceReport.cloudStatus.toUpperCase() === 'RUNNING')
        );
    }

    private getInstanceReportsMap(
        group: InstanceGroup,
        instanceStates: InstanceState[],
        cloudInstances: CloudInstance[],
    ): Map<string, InstanceReport> {
        const instanceReports = new Map<string, InstanceReport>();

        instanceStates.forEach((instanceState) => {
            const instanceReport = <InstanceReport>{
                instanceId: instanceState.instanceId,
                group: group.name,
                displayName: 'unknown',
                instanceName: 'unknown',
                scaleStatus: 'unknown',
                cloudStatus: 'unknown',
                version: 'unknown',
                isShuttingDown: instanceState.shutdownStatus,
                shutdownComplete: instanceState.shutdownComplete,
                lastReconfigured: instanceState.lastReconfigured,
                reconfigureError: instanceState.reconfigureError,
                shutdownError: instanceState.shutdownError,
                isScaleDownProtected: false,
            };
            if (instanceState.shutdownComplete) {
                instanceReport.scaleStatus = 'SHUTDOWN COMPLETE';
            } else if (instanceState.shutdownStatus) {
                instanceReport.scaleStatus = 'SHUTDOWN';
            } else if (instanceState.status.provisioning) {
                instanceReport.scaleStatus = 'PROVISIONING';
            } else {
                switch (group.type) {
                    case 'jibri':
                    case 'sip-jibri':
                        instanceReport.scaleStatus = 'SIDECAR_RUNNING';
                        if (instanceState.status.jibriStatus && instanceState.status.jibriStatus.busyStatus) {
                            instanceReport.scaleStatus = instanceState.status.jibriStatus.busyStatus.toString();
                        }
                        break;
                    case 'nomad':
                        // @TODO: convert nomad stats into more explict statuses
                        instanceReport.scaleStatus = 'SIDECAR_RUNNING';
                        if (instanceState.status.nomadStatus && instanceState.status.nomadStatus.allocatedCPU > 1000) {
                            instanceReport.scaleStatus = 'IN USE';
                        }
                        if (
                            instanceState.status.jigasiStatus &&
                            !instanceState.status.nomadStatus.eligibleForScheduling
                        ) {
                            instanceReport.scaleStatus = 'GRACEFUL SHUTDOWN';
                        }
                        break;
                    case 'jigasi':
                        // @TODO: convert Jigasi stats into more explict statuses
                        instanceReport.scaleStatus = 'ONLINE';
                        if (instanceState.status.jigasiStatus && instanceState.status.jigasiStatus.participants) {
                            instanceReport.scaleStatus = 'IN USE';
                        }
                        if (instanceState.status.jigasiStatus && instanceState.status.jigasiStatus.graceful_shutdown) {
                            instanceReport.scaleStatus = 'GRACEFUL SHUTDOWN';
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

    private async addReconfigureDate(ctx: Context, group: string, instanceReports: InstanceReport[]): Promise<void> {
        const reconfigureDates = await this.reconfigureManager.getReconfigureDates(
            ctx,
            group,
            instanceReports.map((instanceReport) => {
                return instanceReport.instanceId;
            }),
        );

        for (let i = 0; i < instanceReports.length; i++) {
            instanceReports[i].reconfigureScheduled = reconfigureDates[i];
        }
    }

    private async addShutdownStatus(ctx: Context, group: string, instanceReports: InstanceReport[]): Promise<void> {
        const shutdownStatuses = await this.shutdownManager.getShutdownStatuses(
            ctx,
            group,
            instanceReports.map((instanceReport) => {
                return instanceReport.instanceId;
            }),
        );

        const instanceReportsShutdownStatus: boolean[] = [];
        for (let i = 0; i < instanceReports.length; i++) {
            instanceReportsShutdownStatus.push(instanceReports[i].isShuttingDown || shutdownStatuses[i]);
        }

        instanceReports.forEach((instanceReport, index) => {
            instanceReport.isShuttingDown = instanceReportsShutdownStatus[index];
        });
    }

    private async addShutdownConfirmations(
        ctx: Context,
        group: string,
        instanceReports: InstanceReport[],
    ): Promise<void> {
        (
            await this.shutdownManager.getShutdownConfirmations(
                ctx,
                group,
                instanceReports.map((instanceReport) => {
                    return instanceReport.instanceId;
                }),
            )
        ).map((confirmation, index) => {
            instanceReports[index].shutdownComplete = confirmation;
        });
    }

    private async addShutdownProtectedStatus(
        ctx: Context,
        group: string,
        instanceReports: InstanceReport[],
    ): Promise<void> {
        const instanceReportsProtectedStatus: boolean[] = await this.shutdownManager.areScaleDownProtected(
            ctx,
            group,
            instanceReports.map((instanceReport) => {
                return instanceReport.instanceId;
            }),
        );
        instanceReports.forEach((instanceReport, index) => {
            instanceReport.isScaleDownProtected = instanceReportsProtectedStatus[index];
        });
    }
}
