import { Context } from './context';
import Redis from 'ioredis';
import ShutdownManager from './shutdown_manager';
import Audit from './audit';
import { InstanceGroup } from './instance_group';

/* eslint-disable */
function isEmpty(obj: any) {
    /* eslint-enable */
    for (const i in obj) return false;
    return true;
}

export enum JibriStatusState {
    Idle = 'IDLE',
    Busy = 'BUSY',
    Expired = 'EXPIRED',
}

export enum JibriHealthState {
    Healthy = 'HEALTHY',
    Unhealthy = 'UNHEALTHY',
}

interface JibriStatusReport {
    status: JibriStatus;
}

export interface JibriStatus {
    busyStatus: JibriStatusState;
    health: JibriHealth;
}

export interface JibriHealth {
    healthStatus: JibriHealthState;
}

export interface JVBStatus {
    stress_level: number;
    muc_clients_configured: number;
    muc_clients_connected: number;
    conferences: number;
    participants: number;
    largest_conference: number;
    graceful_shutdown: boolean;
}

export interface NomadReportStats {
    Gauges: NomadGauge[];
}

interface NomadLabels {
    [key: string]: string;
}

interface NomadStats {
    [key: string]: number;
}

interface NomadGauge {
    Labels: NomadLabels;
    Name: string;
    Value: number;
}

export interface NomadStatus {
    stress_level: number;
    totalCPU: number;
    eligibleForScheduling: boolean;
    allocatedCPU: number;
    allocatedMemory: number;
    unallocatedCPU: number;
    unallocatedMemory: number;
}

export interface JigasiStatus {
    stress_level: number;
    // muc_clients_configured: number;
    // muc_clients_connected: number;
    conferences: number;
    participants: number;
    // largest_conference: number;
    graceful_shutdown: boolean;
}
export interface InstanceDetails {
    instanceId: string;
    instanceType: string;
    cloud?: string;
    region?: string;
    group?: string;
    name?: string;
    version?: string;
    publicIp?: string;
    privateIp?: string;
}

export interface StatsReport {
    instance: InstanceDetails;
    timestamp?: number;
    stats: unknown;
    shutdownStatus?: boolean;
    shutdownError?: boolean;
    reconfigureError?: boolean;
    statsError?: boolean;
    reconfigureComplete?: string;
}

export interface InstanceStatus {
    provisioning: boolean;
    jibriStatus?: JibriStatus;
    jvbStatus?: JVBStatus;
    jigasiStatus?: JigasiStatus;
    nomadStatus?: NomadStatus;
}

export interface InstanceMetric {
    instanceId: string;
    timestamp: number;
    value: number;
}

export interface InstanceMetadata {
    group: string;
    publicIp?: string;
    privateIp?: string;
    version?: string;
    name?: string;

    [key: string]: string;
}

export interface InstanceState {
    instanceId: string;
    instanceType: string;
    status: InstanceStatus;
    timestamp?: number;
    metadata: InstanceMetadata;
    shutdownStatus?: boolean;
    shutdownComplete?: string;
    reconfigureError?: boolean;
    shutdownError?: boolean;
    statsError?: boolean;
    lastReconfigured?: string;
}

export interface InstanceTrackerOptions {
    redisClient: Redis;
    redisScanCount: number;
    shutdownManager: ShutdownManager;
    audit: Audit;
    idleTTL: number;
    metricTTL: number;
    provisioningTTL: number;
    shutdownStatusTTL: number;
    groupRelatedDataTTL: number;
}

export class InstanceTracker {
    private redisClient: Redis;
    private readonly redisScanCount: number;
    private shutdownManager: ShutdownManager;
    private audit: Audit;
    private readonly idleTTL: number;
    private readonly provisioningTTL: number;
    private readonly shutdownStatusTTL: number;
    private readonly metricTTL: number;
    private readonly groupRelatedDataTTL: number;

    constructor(options: InstanceTrackerOptions) {
        this.redisClient = options.redisClient;
        this.redisScanCount = options.redisScanCount;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;
        this.idleTTL = options.idleTTL;
        this.provisioningTTL = options.provisioningTTL;
        this.shutdownStatusTTL = options.shutdownStatusTTL;
        this.metricTTL = options.metricTTL;
        this.groupRelatedDataTTL = options.groupRelatedDataTTL;

        this.track = this.track.bind(this);
        this.getInstanceStates = this.getInstanceStates.bind(this);
        this.filterOutAndTrimExpiredStates = this.filterOutAndTrimExpiredStates.bind(this);
    }

    // @TODO: handle stats for instances
    async stats(ctx: Context, report: StatsReport, shutdownStatus = false): Promise<void> {
        ctx.logger.debug('Received report', { report });
        const instanceState = <InstanceState>{
            instanceId: report.instance.instanceId,
            instanceType: report.instance.instanceType,
            metadata: <InstanceMetadata>{ ...report.instance },
            status: {
                provisioning: false,
            },
            timestamp: report.timestamp,
            shutdownStatus: report.shutdownStatus,
            shutdownError: report.shutdownError,
            reconfigureError: report.reconfigureError,
            statsError: report.statsError,
        };

        if (report.reconfigureComplete) {
            instanceState.lastReconfigured = report.reconfigureComplete;
        }

        if (isEmpty(report.stats) || report.statsError) {
            // empty stats report, this can happen either at provisioning when jibri is not yet up, or when the sidecar does not see a jibri
            ctx.logger.warn('Empty stats report, as it does not include jibri or jvb stats', { report });
            // TODO: increment stats report error counter
        } else {
            let jibriStatusReport: JibriStatusReport;
            switch (report.instance.instanceType) {
                case 'jibri':
                case 'sip-jibri':
                    jibriStatusReport = <JibriStatusReport>report.stats;
                    instanceState.status.jibriStatus = jibriStatusReport.status;
                    break;
                case 'jigasi':
                    instanceState.status.jigasiStatus = <JigasiStatus>report.stats;
                    break;
                case 'nomad':
                    instanceState.status.nomadStatus = this.nomadStatusFromStats(<NomadReportStats>report.stats);
                    break;
                case 'JVB':
                    instanceState.status.jvbStatus = <JVBStatus>report.stats;
                    break;
            }
        }
        ctx.logger.debug('Tracking instance state', { instanceState });
        return await this.track(ctx, instanceState, shutdownStatus);
    }

    private nomadStatsFromReportGauges(gauges: NomadGauge[]): NomadStats {
        const outStats = <NomadStats>{};
        for (const g of gauges) {
            outStats[g.Name] = g.Value;
        }

        return outStats;
    }

    private nomadLabelsFromReportGauges(gauges: NomadGauge[]): NomadLabels {
        return gauges[0].Labels;
    }

    private nomadStatusFromStats(stats: NomadReportStats): NomadStatus {
        const nomadStats = this.nomadStatsFromReportGauges(stats.Gauges);
        const nomadLabels = this.nomadLabelsFromReportGauges(stats.Gauges);
        const totalCPU = nomadStats['nomad.client.allocated.cpu'] + nomadStats['nomad.client.unallocated.cpu'];

        return <NomadStatus>{
            totalCPU,
            stress_level: nomadStats['nomad.client.allocated.cpu'] / totalCPU,
            eligibleForScheduling: nomadLabels['node_scheduling_eligibility'] == 'eligible',
            allocatedCPU: nomadStats['nomad.client.allocated.cpu'],
            allocatedMemory: nomadStats['nomad.client.allocated.memory'],
            unallocatedCPU: nomadStats['nomad.client.unallocated.cpu'],
            unallocatedMemory: nomadStats['nomad.client.unallocated.memory'],
        };
    }

    private getGroupInstancesStatesKey(groupName: string): string {
        return `instances:status:${groupName}`;
    }

    private getGroupMetricsKey(groupName: string): string {
        return `gmetric:instance:${groupName}`;
    }

    private async extendTTLForKey(key: string, ttl: number): Promise<boolean> {
        const result = await this.redisClient.expire(key, ttl);
        return result == 1;
    }

    async track(ctx: Context, state: InstanceState, shutdownStatus = false): Promise<void> {
        let group = 'default';

        // pull the group from metadata if provided
        if (state.metadata && state.metadata.group) {
            group = state.metadata.group;
        }

        const instanceStateTimestamp = Number(state.timestamp);
        if (!instanceStateTimestamp) {
            state.timestamp = Date.now();
        }

        // Store latest instance status
        await this.redisClient.hset(
            this.getGroupInstancesStatesKey(group),
            `${state.instanceId}`,
            JSON.stringify(state),
        );

        const isInstanceShuttingDown = this.shutdownStatusFromState(state) || shutdownStatus;
        // Store metric, but only for running instances
        if (!state.status.provisioning && !isInstanceShuttingDown) {
            let metricValue = 0;
            let trackMetric = true;
            switch (state.instanceType) {
                case 'jibri':
                case 'sip-jibri':
                    if (state.status.jibriStatus && state.status.jibriStatus.busyStatus == JibriStatusState.Idle) {
                        metricValue = 1;
                    }
                    // If Jibri is not up, the available metric is tracked with value 0
                    break;
                case 'jigasi':
                    if (!state.status.jigasiStatus) {
                        // If Jigasi is not up or is in graceful shutdown, we should not use it to compute average stress level across the group
                        trackMetric = false;
                    } else if (state.status.jigasiStatus.stress_level) {
                        metricValue = state.status.jigasiStatus.stress_level;
                    }
                    break;
                case 'nomad':
                    if (!state.status.nomadStatus) {
                        // If nomad node is not up or is in graceful shutdown, we should not use it to compute average stress level across the group
                        trackMetric = false;
                    } else if (state.status.nomadStatus.stress_level) {
                        metricValue = state.status.nomadStatus.stress_level;
                    }
                    break;
                case 'JVB':
                    if (!state.status.jvbStatus) {
                        // If JVB is not up or is in graceful shutdown, we should not use it to compute average stress level across the group
                        trackMetric = false;
                    } else if (state.status.jvbStatus.stress_level) {
                        metricValue = state.status.jvbStatus.stress_level;
                    }
                    break;
            }

            if (trackMetric) {
                const metricObject: InstanceMetric = {
                    instanceId: state.instanceId,
                    timestamp: state.timestamp,
                    value: metricValue,
                };
                await this.redisClient.zadd(
                    this.getGroupMetricsKey(group),
                    metricObject.timestamp,
                    JSON.stringify(metricObject),
                );
            }
        }

        //monitor latest status
        await this.audit.saveLatestStatus(group, state.instanceId, state);
        return;
    }

    async getSummaryMetricPerPeriod(
        ctx: Context,
        group: InstanceGroup,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
        periodCount: number,
    ): Promise<Array<number>> {
        switch (group.type) {
            case 'jibri':
            case 'sip-jibri':
                return this.getAvailableMetricPerPeriod(ctx, metricInventoryPerPeriod, periodCount);
            case 'nomad':
            case 'jigasi':
            case 'JVB':
                return this.getAverageMetricPerPeriod(ctx, metricInventoryPerPeriod, periodCount);
        }
        return;
    }

    async getAvailableMetricPerPeriod(
        ctx: Context,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
        periodCount: number,
    ): Promise<Array<number>> {
        ctx.logger.debug(`Getting available metric per period for ${periodCount} periods`, {
            metricInventoryPerPeriod,
        });

        return metricInventoryPerPeriod.slice(0, periodCount).map((instanceMetrics) => {
            return this.computeSummaryMetric(instanceMetrics, false);
        });
    }

    async getAverageMetricPerPeriod(
        ctx: Context,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
        periodCount: number,
    ): Promise<Array<number>> {
        ctx.logger.debug(`Getting average metric per period for ${periodCount} periods`, {
            metricInventoryPerPeriod,
        });

        return metricInventoryPerPeriod.slice(0, periodCount).map((instanceMetrics) => {
            return this.computeSummaryMetric(instanceMetrics, true);
        });
    }

    async getMetricInventoryPerPeriod(
        ctx: Context,
        group: string,
        periodsCount: number,
        periodDurationSeconds: number,
    ): Promise<Array<Array<InstanceMetric>>> {
        const metricPoints: Array<Array<InstanceMetric>> = [];
        const currentTime = Date.now();
        const validUntil = new Date(currentTime - 1000 * this.metricTTL).getTime();

        // Extend TTL longer enough for the key to be deleted only after the group is deleted or no action is performed on it
        await this.extendTTLForKey(this.getGroupMetricsKey(group), this.groupRelatedDataTTL);

        const cleanupStart = process.hrtime();
        const itemsCleanedUp: number = await this.redisClient.zremrangebyscore(
            this.getGroupMetricsKey(group),
            0,
            validUntil,
        );
        const cleanupEnd = process.hrtime(cleanupStart);
        ctx.logger.info(
            `Cleaned up ${itemsCleanedUp} metrics in ${
                cleanupEnd[0] * 1000 + cleanupEnd[1] / 1000000
            } ms, for group ${group}`,
        );

        const instancesInPeriods = <string[][]>[];
        for (let periodIdx = 0; periodIdx < periodsCount; periodIdx++) {
            metricPoints[periodIdx] = [];
            instancesInPeriods[periodIdx] = [];
        }

        const inventoryStart = process.hrtime();
        const items: string[] = await this.redisClient.zrange(this.getGroupMetricsKey(group), 0, -1);

        const instancesInMetrics = <string[]>[];
        items.forEach((item) => {
            if (item) {
                const itemJson = JSON.parse(item);
                const periodIdx = Math.floor((currentTime - itemJson.timestamp) / (periodDurationSeconds * 1000));
                if (periodIdx >= 0 && periodIdx < periodsCount) {
                    metricPoints[periodIdx].push(itemJson);
                    if (!instancesInMetrics.includes(itemJson.instanceId)) {
                        instancesInMetrics.push(itemJson.instanceId);
                    }
                    if (!instancesInPeriods[periodIdx].includes(itemJson.instanceId)) {
                        instancesInPeriods[periodIdx].push(itemJson.instanceId);
                    }
                }
            }
        });

        // loop through all periods except the last, and fill in missing metrics
        for (let periodIdx = periodsCount - 2; periodIdx >= 0; periodIdx--) {
            instancesInMetrics
                .filter((instanceId) => {
                    return !instancesInPeriods[periodIdx].includes(instanceId);
                })
                .map((instanceId) => {
                    // only fill in a missing metric if the instance is present in the next period and the previous period
                    if (
                        instancesInPeriods[periodIdx + 1].includes(instanceId) &&
                        (periodIdx == 0 || instancesInPeriods[periodIdx - 1].includes(instanceId))
                    ) {
                        const previousMetric = metricPoints[periodIdx + 1]
                            .sort((a, b) => {
                                return b.timestamp - a.timestamp;
                            })
                            .find((metric) => {
                                return metric.instanceId === instanceId;
                            });
                        if (previousMetric) {
                            ctx.logger.info('Filling in for missing metric from previous period', {
                                group,
                                instanceId,
                                periodIdx,
                                previousMetric,
                            });
                            metricPoints[periodIdx].push(previousMetric);
                        }
                    }
                });
        }

        const inventoryEnd = process.hrtime(inventoryStart);
        ctx.logger.debug(`instance metric periods: `, { group, periodsCount, periodDurationSeconds, metricPoints });

        ctx.logger.info(
            `Returned ${metricPoints.length} metrics in ${
                inventoryEnd[0] * 1000 + inventoryEnd[1] / 1000000
            } ms, for group ${group}`,
        );

        return metricPoints;
    }

    computeSummaryMetric(instanceMetrics: Array<InstanceMetric>, averageFlag = false): number {
        const dataPointsPerInstance: Map<string, number> = new Map();
        const aggregatedDataPerInstance: Map<string, number> = new Map();

        instanceMetrics.forEach((instanceMetric) => {
            let currentDataPoints = dataPointsPerInstance.get(instanceMetric.instanceId);
            if (!currentDataPoints) {
                currentDataPoints = 0;
            }
            dataPointsPerInstance.set(instanceMetric.instanceId, currentDataPoints + 1);

            let currentAggregatedValue = aggregatedDataPerInstance.get(instanceMetric.instanceId);
            if (!currentAggregatedValue) {
                currentAggregatedValue = 0;
            }
            aggregatedDataPerInstance.set(instanceMetric.instanceId, currentAggregatedValue + instanceMetric.value);
        });

        const instanceIds: Array<string> = Array.from(aggregatedDataPerInstance.keys());

        if (instanceIds.length > 0) {
            const fullSum = instanceIds
                .map((instanceId) => {
                    return aggregatedDataPerInstance.get(instanceId) / dataPointsPerInstance.get(instanceId);
                })
                .reduce((previousSum, currentValue) => {
                    return previousSum + currentValue;
                });
            if (averageFlag) {
                return fullSum / instanceIds.length;
            } else {
                return fullSum;
            }
        } else {
            return 0;
        }
    }

    async trimCurrent(ctx: Context, group: string, filterShutdown = true): Promise<Array<InstanceState>> {
        let states: Array<InstanceState> = [];
        const currentStart = process.hrtime();
        const groupInstancesStatesKey = this.getGroupInstancesStatesKey(group);

        // Extend TTL longer enough for the key to be deleted only after the group is deleted or no action is performed on it
        await this.extendTTLForKey(groupInstancesStatesKey, this.groupRelatedDataTTL);

        let cursor = '0';
        let scanCounts = 0;
        do {
            const result = await this.redisClient.hscan(
                groupInstancesStatesKey,
                cursor,
                'MATCH',
                `*`,
                'COUNT',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const instanceStates = await this.getInstanceStates(result[1], groupInstancesStatesKey);
                const validInstanceStates = await this.filterOutAndTrimExpiredStates(
                    ctx,
                    groupInstancesStatesKey,
                    instanceStates,
                );
                states = states.concat(validInstanceStates);
            }
            scanCounts++;
        } while (cursor != '0');
        ctx.logger.debug(`instance states: ${states}`, { group, states });
        const currentEnd = process.hrtime(currentStart);
        ctx.logger.info(
            `Scanned ${states.length} group instances in ${scanCounts} scans and ${
                currentEnd[0] * 1000 + currentEnd[1] / 1000000
            } ms, for group ${group}`,
        );

        if (filterShutdown) {
            const filterShutdownStart = process.hrtime();
            const statesExceptShutDown = await this.filterOutInstancesShuttingDown(ctx, states);
            const filterShutdownEnd = process.hrtime(filterShutdownStart);
            ctx.logger.debug(`instance filtered states, with no shutdown instances: ${statesExceptShutDown}`, {
                group,
                statesExceptShutDown,
            });

            ctx.logger.info(
                `Filtered out shutting down from ${states.length} instances in ${
                    filterShutdownEnd[0] * 1000 + filterShutdownEnd[1] / 1000000
                } ms for group ${group}`,
            );
            return statesExceptShutDown;
        }
        return states;
    }

    private async getInstanceStates(fields: string[], groupInstancesStatesKey: string): Promise<Array<InstanceState>> {
        const instanceStatesResponse: Array<InstanceState> = [];
        const pipeline = this.redisClient.pipeline();

        fields.forEach((instanceId: string) => {
            pipeline.hget(groupInstancesStatesKey, instanceId);
        });
        const instanceStates = await pipeline.exec();

        if (instanceStates) {
            for (const state of instanceStates) {
                if (state[1]) {
                    instanceStatesResponse.push(<InstanceState>JSON.parse(<string>state[1]));
                }
            }
        } else {
            return [];
        }

        return instanceStatesResponse;
    }

    private shutdownStatusFromState(state: InstanceState) {
        let shutdownStatus = false;
        shutdownStatus = state.shutdownStatus;
        if (!shutdownStatus) {
            // check whether jigasi or JVB reports graceful shutdown, treat as if sidecar has acknowledge shutdown command
            if (
                state.status &&
                ((state.status.jvbStatus && state.status.jvbStatus.graceful_shutdown) ||
                    (state.status.jigasiStatus && state.status.jigasiStatus.graceful_shutdown) ||
                    (state.status.nomadStatus && !state.status.nomadStatus.eligibleForScheduling))
            ) {
                shutdownStatus = true;
            }
        }

        return shutdownStatus;
    }

    private async filterOutAndTrimExpiredStates(
        ctx: Context,
        groupInstancesStatesKey: string,
        instanceStates: Array<InstanceState>,
    ): Promise<Array<InstanceState>> {
        const groupInstancesStatesResponse: Array<InstanceState> = [];
        const deletePipeline = this.redisClient.pipeline();

        const shutdownStatuses: boolean[] = await this.shutdownManager.getShutdownStatuses(
            ctx,
            instanceStates.map((instanceState) => {
                return instanceState.instanceId;
            }),
        );

        for (let i = 0; i < instanceStates.length; i++) {
            const state = instanceStates[i];
            let statusTTL = this.idleTTL;
            if (state.status && state.status.provisioning) {
                statusTTL = this.provisioningTTL;
            }

            const isInstanceShuttingDown = this.shutdownStatusFromState(state) || shutdownStatuses[i];
            if (isInstanceShuttingDown) {
                // We keep shutdown status a bit longer, to be consistent to Oracle Search API which has a delay in seeing Terminating status
                statusTTL = this.shutdownStatusTTL;
            }

            const expiresAt = new Date(state.timestamp + 1000 * statusTTL);
            const isValidState: boolean = expiresAt >= new Date();
            if (isValidState) {
                groupInstancesStatesResponse.push(state);
            } else {
                deletePipeline.hdel(groupInstancesStatesKey, state.instanceId);
                ctx.logger.debug(`will delete expired state:`, {
                    expiresAt,
                    state,
                });
            }
        }
        await deletePipeline.exec();
        return groupInstancesStatesResponse;
    }

    async filterOutInstancesShuttingDown(ctx: Context, states: Array<InstanceState>): Promise<Array<InstanceState>> {
        const shutdownStatuses = await this.shutdownManager.getShutdownStatuses(
            ctx,
            states.map((state) => {
                return state.instanceId;
            }),
        );

        const statesShutdownStatus: boolean[] = [];
        for (let i = 0; i < states.length; i++) {
            statesShutdownStatus.push(this.shutdownStatusFromState(states[i]) || shutdownStatuses[i]);
        }
        return states.filter((instanceState, index) => !statesShutdownStatus[index]);
    }

    mapToInstanceDetails(states: Array<InstanceState>): Array<InstanceDetails> {
        return states.map((response) => {
            return <InstanceDetails>{
                instanceId: response.instanceId,
                instanceType: response.instanceType,
                group: response.metadata.group,
            };
        });
    }
}
