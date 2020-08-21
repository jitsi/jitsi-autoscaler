import Redis from 'ioredis';
import { Context } from './context';
import { JibriTracker, JibriState, JibriStatus, JibriMetaData } from './jibri_tracker';

const StatsTTL = 900;

export interface InstanceDetails {
    instanceId: string;
    instanceType: string;
    cloud?: string;
    region?: string;
    group?: string;
}

export interface StatsReport {
    instance: InstanceDetails;
    timestamp?: number;
    stats: unknown;
    shutdownStatus?: boolean;
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
        switch (report.instance.instanceType) {
            case 'jibri':
                jibriStats = <JibriStats>report.stats;
                jibriState = {
                    jibriId: report.instance.instanceId,
                    status: jibriStats.status,
                    timestamp: report.timestamp,
                    shutdownStatus: report.shutdownStatus,
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
        return statsResult;
    }
}
