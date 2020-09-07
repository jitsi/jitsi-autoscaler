import Redis from 'ioredis';
import { Context } from './context';
import { JibriTracker, JibriState, JibriStatus, JibriMetaData } from './jibri_tracker';

/* eslint-disable */
    function isEmpty(obj: any) {
    /* eslint-enable */
    for (const i in obj) return false;
    return true;
}

const StatsTTL = 900;

export interface InstanceDetails {
    instanceId: string;
    instanceType: string;
    cloud?: string;
    region?: string;
    group?: string;
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

export interface InstanceStatusOptions {
    redisClient: Redis.Redis;
    jibriTracker: JibriTracker;
}

export interface JibriStats {
    status: JibriStatus;
}

export class InstanceStatus {
    private redisClient: Redis.Redis;
    private jibriTracker: JibriTracker;

    constructor(options: InstanceStatusOptions) {
        this.redisClient = options.redisClient;
        this.jibriTracker = options.jibriTracker;
        this.stats = this.stats.bind(this);
    }

    instanceKey(details: InstanceDetails, type: string): string {
        return `instance:${type}:${details.instanceId}`;
    }

    // @TODO: handle stats like JibriTracker does
    async stats(ctx: Context, report: StatsReport): Promise<boolean> {
        let statsResult = false;
        let key: string;
        let jibriState: JibriState;
        let jibriStats: JibriStats;
        ctx.logger.debug('Received report', { report });
        if (isEmpty(report.stats) || report.statsError) {
            // empty stats report, so error
            ctx.logger.error('Empty stats report, not processing', { report });
            // TODO: increment stats report error counter
        } else {
            switch (report.instance.instanceType) {
                case 'jibri':
                    jibriStats = <JibriStats>report.stats;
                    jibriState = {
                        jibriId: report.instance.instanceId,
                        status: jibriStats.status,
                        timestamp: report.timestamp,
                        shutdownStatus: report.shutdownStatus,
                        shutdownError: report.shutdownError,
                        reconfigureError: report.reconfigureError,
                        statsError: report.statsError,
                        metadata: <JibriMetaData>{ ...report.instance },
                    };
                    ctx.logger.debug('Tracking jibri state', { state: jibriState });
                    statsResult = await this.jibriTracker.track(ctx, jibriState);
                    break;
                default:
                    key = this.instanceKey(report.instance, 'stats');
                    ctx.logger.debug('Writing instance stats', { key, stats: report.stats });
                    await this.redisClient.set(key, JSON.stringify(report.stats), 'ex', StatsTTL);
                    statsResult = true;
                    break;
            }
        }
        return statsResult;
    }
}
