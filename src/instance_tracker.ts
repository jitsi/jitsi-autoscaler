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
}

export interface InstanceStatus {
    provisioning: boolean;
    jibriStatus?: JibriStatus;
    jvbStatus?: JVBStatus;
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
    reconfigureError?: boolean;
    shutdownError?: boolean;
    statsError?: boolean;
}

export interface InstanceTrackerOptions {
    redisClient: Redis.Redis;
    redisScanCount: number;
    shutdownManager: ShutdownManager;
    audit: Audit;
    idleTTL: number;
    metricTTL: number;
    provisioningTTL: number;
    shutdownStatusTTL: number;
}

export class InstanceTracker {
    private redisClient: Redis.Redis;
    private readonly redisScanCount: number;
    private shutdownManager: ShutdownManager;
    private audit: Audit;
    private readonly idleTTL: number;
    private readonly provisioningTTL: number;
    private readonly shutdownStatusTTL: number;
    private readonly metricTTL: number;

    constructor(options: InstanceTrackerOptions) {
        this.redisClient = options.redisClient;
        this.redisScanCount = options.redisScanCount;
        this.shutdownManager = options.shutdownManager;
        this.audit = options.audit;
        this.idleTTL = options.idleTTL;
        this.provisioningTTL = options.provisioningTTL;
        this.shutdownStatusTTL = options.shutdownStatusTTL;
        this.metricTTL = options.metricTTL;

        this.track = this.track.bind(this);
        this.getInstanceStates = this.getInstanceStates.bind(this);
        this.filterOutAndTrimExpiredStates = this.filterOutAndTrimExpiredStates.bind(this);
    }

    // @TODO: handle stats for instances
    async stats(ctx: Context, report: StatsReport, shutdownStatus = false): Promise<boolean> {
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
        if (isEmpty(report.stats) || report.statsError) {
            // empty stats report, this can happen either at provisioning when jibri is not yet up, or when the sidecar does not see a jibri
            ctx.logger.warn('Empty stats report, as it does not include jibri or jvb stats', { report });
            // TODO: increment stats report error counter
        } else {
            let jibriStatusReport: JibriStatusReport;
            switch (report.instance.instanceType) {
                case 'jibri':
                    jibriStatusReport = <JibriStatusReport>report.stats;
                    instanceState.status.jibriStatus = jibriStatusReport.status;
                    break;
                case 'JVB':
                    instanceState.status.jvbStatus = <JVBStatus>report.stats;
                    break;
            }
        }
        ctx.logger.debug('Tracking instance state', { instanceState });
        return await this.track(ctx, instanceState, shutdownStatus);
    }

    private getGroupInstancesStatesKey(groupName: string): string {
        return `instances:status:${groupName}`;
    }

    async track(ctx: Context, state: InstanceState, shutdownStatus = false): Promise<boolean> {
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

        const isInstanceShuttingDown = state.shutdownStatus || shutdownStatus;
        // Store metric, but only for running instances
        if (!state.status.provisioning && !isInstanceShuttingDown) {
            let metricValue = 0;
            let trackMetric = true;
            switch (state.instanceType) {
                case 'jibri':
                    if (state.status.jibriStatus && state.status.jibriStatus.busyStatus == JibriStatusState.Idle) {
                        metricValue = 1;
                    }
                    // If Jibri is not up, the available metric is tracked with value 0
                    break;
                case 'JVB':
                    if (!state.status.jvbStatus) {
                        // If JVB is not up, we should not use it to compute average stress level across jvbs
                        trackMetric = false;
                    } else if (state.status.jvbStatus.stress_level) {
                        metricValue = state.status.jvbStatus.stress_level;
                    }
                    break;
            }

            if (trackMetric) {
                const metricKey = `metric:instance:${group}:${state.instanceId}:${state.timestamp}`;
                const metricObject: InstanceMetric = {
                    instanceId: state.instanceId,
                    timestamp: state.timestamp,
                    value: metricValue,
                };
                const resultMetric = await this.redisClient.set(
                    metricKey,
                    JSON.stringify(metricObject),
                    'ex',
                    this.metricTTL,
                );
                if (resultMetric !== 'OK') {
                    ctx.logger.error(`unable to set ${metricKey}`);
                    throw new Error(`unable to set ${metricKey}`);
                }
            }
        }

        //monitor latest status
        await this.audit.saveLatestStatus(group, state.instanceId, state);
        return true;
    }

    async getSummaryMetricPerPeriod(
        ctx: Context,
        group: InstanceGroup,
        metricInventoryPerPeriod: Array<Array<InstanceMetric>>,
        periodCount: number,
    ): Promise<Array<number>> {
        switch (group.type) {
            case 'jibri':
                return this.getAvailableMetricPerPeriod(ctx, metricInventoryPerPeriod, periodCount);
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

        for (let periodIdx = 0; periodIdx < periodsCount; periodIdx++) {
            metricPoints[periodIdx] = [];
        }

        let cursor = '0';
        let scanCount = 0;
        const inventoryStart = process.hrtime();
        do {
            const result = await this.redisClient.scan(
                cursor,
                'match',
                `metric:instance:${group}:*`,
                'count',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const pipeline = this.redisClient.pipeline();
                result[1].forEach((key: string) => {
                    pipeline.get(key);
                });

                const items = await pipeline.exec();
                items.forEach((item) => {
                    if (item[1]) {
                        const itemJson = JSON.parse(item[1]);

                        const periodIdx = Math.floor(
                            (currentTime - itemJson.timestamp) / (periodDurationSeconds * 1000),
                        );
                        if (periodIdx >= 0 && periodIdx < periodsCount) {
                            metricPoints[periodIdx].push(itemJson);
                        }
                    }
                });
            }
            scanCount++;
        } while (cursor != '0');
        const inventoryEnd = process.hrtime(inventoryStart);
        ctx.logger.debug(`instance metric periods: `, { group, periodsCount, periodDurationSeconds, metricPoints });

        ctx.logger.info(
            `Scanned ${metricPoints.length} metrics in ${scanCount} scans and ${
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

        let cursor = '0';
        let scanCounts = 0;
        do {
            const result = await this.redisClient.hscan(
                groupInstancesStatesKey,
                cursor,
                'match',
                `*`,
                'count',
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

        for (const state of instanceStates) {
            if (state[1]) {
                instanceStatesResponse.push(JSON.parse(state[1]));
            }
        }
        return instanceStatesResponse;
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

            const isInstanceShuttingDown = state.shutdownStatus || shutdownStatuses[i];
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
            statesShutdownStatus.push(states[i].shutdownStatus || shutdownStatuses[i]);
        }
        return states.filter((instanceState, index) => !statesShutdownStatus[index]);
    }
}
