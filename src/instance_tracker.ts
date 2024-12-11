import { Context } from './context';
import ShutdownManager from './shutdown_manager';
import Audit from './audit';
import MetricsStore, { InstanceMetric } from './metrics_store';
import InstanceStore, {
    InstanceDetails,
    InstanceGroup,
    InstanceMetadata,
    InstanceState,
    JibriStatus,
    JibriStatusState,
    NomadStatus,
    StressStatus,
} from './instance_store';

/* eslint-disable */
function isEmpty(obj: any) {
    /* eslint-enable */
    for (const i in obj) return false;
    return true;
}

interface JibriStatusReport {
    status: JibriStatus;
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

export interface InstanceTrackerOptions {
    metricsStore: MetricsStore;
    instanceStore: InstanceStore;
    shutdownManager: ShutdownManager;
    audit: Audit;
}

export class InstanceTracker {
    private shutdownManager: ShutdownManager;
    private audit: Audit;
    private metricsStore: MetricsStore;
    private instanceStore: InstanceStore;

    constructor(options: InstanceTrackerOptions) {
        this.metricsStore = options.metricsStore;
        this.instanceStore = options.instanceStore;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;
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
                case 'availability':
                    jibriStatusReport = <JibriStatusReport>report.stats;
                    instanceState.status.jibriStatus = jibriStatusReport.status;
                    break;
                case 'jigasi':
                case 'JVB':
                case 'whisper':
                case 'stress':
                    instanceState.status.stats = <StressStatus>report.stats;
                    break;
                case 'nomad':
                    instanceState.status.stats = <StressStatus>(
                        this.nomadStatusFromStats(<NomadReportStats>report.stats)
                    );
                    break;
            }
        }
        ctx.logger.debug('Tracking instance state', { instanceState });
        instanceState.isShuttingDown = this.shutdownStatusFromState(instanceState);
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
            graceful_shutdown: nomadLabels['node_scheduling_eligibility'] != 'eligible',
            eligibleForScheduling: nomadLabels['node_scheduling_eligibility'] == 'eligible',
            allocatedCPU: nomadStats['nomad.client.allocated.cpu'],
            allocatedMemory: nomadStats['nomad.client.allocated.memory'],
            unallocatedCPU: nomadStats['nomad.client.unallocated.cpu'],
            unallocatedMemory: nomadStats['nomad.client.unallocated.memory'],
        };
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
        this.instanceStore.saveInstanceStatus(ctx, group, state);

        const isInstanceShuttingDown = state.isShuttingDown || shutdownStatus;
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
                case 'nomad':
                case 'JVB':
                case 'whisper':
                case 'stress':
                    // If node is not up or is in graceful shutdown, we should not use it to compute average stress level across the group
                    if (!state.status.stats || state.status.stats.stress_level == undefined) {
                        trackMetric = false;
                    } else {
                        metricValue = state.status.stats.stress_level;
                    }
                    break;
            }

            if (trackMetric) {
                const metricObject: InstanceMetric = {
                    instanceId: state.instanceId,
                    timestamp: state.timestamp,
                    value: metricValue,
                };
                await this.metricsStore.writeInstanceMetric(ctx, group, metricObject);
            }
        }

        //monitor latest status
        await this.audit.saveLatestStatus(group, state.instanceId, state);
        return;
    }

    async getSummaryMetricPerPeriod(
        ctx: Context,
        group: InstanceGroup,
        metricInventoryPerPeriod: InstanceMetric[][],
        periodCount: number,
    ): Promise<number[]> {
        switch (group.type) {
            case 'jibri':
            case 'sip-jibri':
            case 'availability':
                return this.getAvailableMetricPerPeriod(ctx, metricInventoryPerPeriod, periodCount);
            case 'nomad':
            case 'jigasi':
            case 'JVB':
            case 'whisper':
            case 'stress':
                return this.getAverageMetricPerPeriod(ctx, metricInventoryPerPeriod, periodCount);
        }
        return;
    }

    async getAvailableMetricPerPeriod(
        ctx: Context,
        metricInventoryPerPeriod: InstanceMetric[][],
        periodCount: number,
    ): Promise<number[]> {
        ctx.logger.debug(`Getting available metric per period for ${periodCount} periods`, {
            metricInventoryPerPeriod,
        });

        return metricInventoryPerPeriod.slice(0, periodCount).map((instanceMetrics) => {
            return this.computeSummaryMetric(instanceMetrics, false);
        });
    }

    async getAverageMetricPerPeriod(
        ctx: Context,
        metricInventoryPerPeriod: InstanceMetric[][],
        periodCount: number,
    ): Promise<number[]> {
        ctx.logger.debug(`Getting average metric per period for ${periodCount} periods`, {
            metricInventoryPerPeriod,
        });

        return metricInventoryPerPeriod.slice(0, periodCount).map((instanceMetrics) => {
            return this.computeSummaryMetric(instanceMetrics, true);
        });
    }

    async fetchInstanceMetrics(ctx: Context, group: string): Promise<InstanceMetric[]> {
        return this.metricsStore.fetchInstanceMetrics(ctx, group);
    }

    async cleanInstanceMetrics(ctx: Context, group: string): Promise<boolean> {
        return this.metricsStore.cleanInstanceMetrics(ctx, group);
    }

    async getMetricInventoryPerPeriod(
        ctx: Context,
        group: string,
        periodsCount: number,
        periodDurationSeconds: number,
    ): Promise<InstanceMetric[][]> {
        const metricPoints: InstanceMetric[][] = [];
        const currentTime = Date.now();

        await this.cleanInstanceMetrics(ctx, group);

        const instancesInPeriods = <string[][]>[];
        for (let periodIdx = 0; periodIdx < periodsCount; periodIdx++) {
            metricPoints[periodIdx] = [];
            instancesInPeriods[periodIdx] = [];
        }

        const inventoryStart = process.hrtime();
        const items = await this.fetchInstanceMetrics(ctx, group);

        const instancesInMetrics = <string[]>[];
        items.forEach((itemJson) => {
            if (itemJson) {
                // const itemJson = JSON.parse(item);
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

    computeSummaryMetric(instanceMetrics: InstanceMetric[], averageFlag = false): number {
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

        const instanceIds: string[] = Array.from(aggregatedDataPerInstance.keys());

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

    async getGroupInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        return this.instanceStore.fetchInstanceStates(ctx, group);
    }

    async filterOutAndTrimExpiredStates(
        ctx: Context,
        group: string,
        states: InstanceState[],
    ): Promise<InstanceState[]> {
        return this.instanceStore.filterOutAndTrimExpiredStates(ctx, group, states);
    }

    async trimCurrent(ctx: Context, group: string, filterShutdown = true): Promise<InstanceState[]> {
        const rawStates = await this.getGroupInstanceStates(ctx, group);
        const states = await this.filterOutAndTrimExpiredStates(ctx, group, rawStates);
        ctx.logger.debug(`instance states`, { group, states });

        if (filterShutdown) {
            const filterShutdownStart = process.hrtime();
            const statesExceptShutDown = await this.filterOutInstancesShuttingDown(ctx, group, states);
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

    private shutdownStatusFromState(state: InstanceState) {
        let shutdownStatus = false;
        shutdownStatus = state.shutdownStatus;
        if (!shutdownStatus) {
            // check whether jigasi, JVB or whisper reports graceful shutdown, treat as if sidecar has acknowledge shutdown command
            if (
                state.status &&
                ((state.status.stats && state.status.stats.graceful_shutdown) ||
                    (state.status.jvbStatus && state.status.jvbStatus.graceful_shutdown) ||
                    (state.status.jigasiStatus && state.status.jigasiStatus.graceful_shutdown) ||
                    (state.status.whisperStatus && state.status.whisperStatus.graceful_shutdown) ||
                    (state.status.nomadStatus && !state.status.nomadStatus.eligibleForScheduling))
            ) {
                shutdownStatus = true;
            }
        }

        return shutdownStatus;
    }

    async filterOutInstancesShuttingDown(
        ctx: Context,
        group: string,
        states: InstanceState[],
    ): Promise<InstanceState[]> {
        const instanceIds = states.map((state) => {
            return state.instanceId;
        });
        const shutdownStatuses = await this.shutdownManager.getShutdownStatuses(ctx, group, instanceIds);

        const shutdownConfirmations = await this.shutdownManager.getShutdownConfirmations(ctx, group, instanceIds);

        const statesShutdownStatus: boolean[] = [];
        for (let i = 0; i < states.length; i++) {
            statesShutdownStatus.push(this.shutdownStatusFromState(states[i]) || shutdownStatuses[i]);
        }
        return states.filter((_, index) => !statesShutdownStatus[index] && !shutdownConfirmations[index]);
    }

    mapToInstanceDetails(states: InstanceState[]): InstanceDetails[] {
        return states.map((response) => {
            return <InstanceDetails>{
                instanceId: response.instanceId,
                instanceType: response.instanceType,
                group: response.metadata.group,
            };
        });
    }
}
