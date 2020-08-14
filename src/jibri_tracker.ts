import { Logger } from 'winston';
import Redlock from 'redlock';
import Redis from 'ioredis';

export enum JibriStatusState {
    Idle = 'IDLE',
    Busy = 'BUSY',
}

export enum JibriHealthState {
    Healthy = 'HEALTHY',
    Unhealthy = 'UNHEALTHY',
}

export interface JibriStatus {
    busyStatus: JibriStatusState;
    health: JibriHealth;
}

export interface JibriHealth {
    healthStatus: JibriHealthState;
}

export interface JibriMetaData {
    group: string;
    [key: string]: string;
}

export interface JibriState {
    jibriId: string;
    status: JibriStatus;
    metadata: JibriMetaData;
}

export interface JibriMetric {
    timestamp: number;
    value: number;
}

export interface JibriTrackerOptions {
    redisClient: Redis.Redis;
    idleTTL: number;
    metricTTL: number;
    gracePeriodTTL: number;
}

export class JibriTracker {
    private redisClient: Redis.Redis;
    private pendingLock: Redlock;
    private logger: Logger;
    private gracePeriodTTL: number;
    private idleTTL: number;
    private metricTTL: number;

    constructor(logger: Logger, options: JibriTrackerOptions) {
        this.logger = logger;
        this.redisClient = options.redisClient;
        this.idleTTL = options.idleTTL;
        this.metricTTL = options.metricTTL;
        this.gracePeriodTTL = options.gracePeriodTTL;
        this.pendingLock = new Redlock(
            // TODO: you should have one client for each independent redis node or cluster
            [this.redisClient],
            {
                driftFactor: 0.01, // time in ms
                retryCount: 3,
                retryDelay: 200, // time in ms
                retryJitter: 200, // time in ms
            },
        );
        this.pendingLock.on('clientError', (err) => {
            this.logger.error('A pendingLock redis error has occurred:', err);
        });
    }

    async track(state: JibriState): Promise<boolean> {
        let group = 'default';
        // pull the group from metadata if provided
        if (state.metadata && state.metadata.group) {
            group = state.metadata.group;
        }

        // Store latest instance status
        const key = `instance:status:${group}:${state.jibriId}`;
        const result = await this.redisClient.set(key, JSON.stringify(state), 'ex', this.idleTTL);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }

        const metricTimestamp = Date.now();
        let metricValue = 0;
        if (state.status.busyStatus == JibriStatusState.Idle) {
            metricValue = 1;
        }
        const metricKey = `metric:available:${group}:${state.jibriId}:${metricTimestamp}`;
        const metricObject: JibriMetric = {
            timestamp: metricTimestamp,
            value: metricValue,
        };
        const resultMetric = await this.redisClient.set(metricKey, JSON.stringify(metricObject), 'ex', this.metricTTL);
        if (resultMetric !== 'OK') {
            throw new Error(`unable to set ${metricKey}`);
        }

        return true;
    }

    async getMetricPeriods(group: string, periodsCount: number, period: number): Promise<Array<JibriMetric>> {
        const metricPoints: Array<JibriMetric> = [];
        let items: Array<string> = [];
        const windowEndTimestamp = Date.now();
        const windowStartTimestamp = windowEndTimestamp - periodsCount * period * 1000;

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `metric:available:${group}:*`);
            cursor = result[0];
            if (result[1].length > 0) {
                items = await this.redisClient.mget(...result[1]);
                items.forEach((item) => {
                    const itemJson = JSON.parse(item);
                    if (itemJson.timestamp >= windowStartTimestamp && itemJson.timestamp <= windowEndTimestamp) {
                        metricPoints.push(itemJson);
                    }
                });
            }
        } while (cursor != '0');
        this.logger.debug(`jibri metric periods: ${metricPoints}`, { group, periodsCount, period });

        return metricPoints;
    }

    async allowScaling(group: string): Promise<boolean> {
        const result = await this.redisClient.get(`gracePeriod:${group}`);
        if (result !== null && result.length > 0) {
            return false;
        }
        return true;
    }

    async setGracePeriod(group: string): Promise<boolean> {
        const key = `gracePeriod:${group}`;
        const result = await this.redisClient.set(key, JSON.stringify(false), 'ex', this.gracePeriodTTL);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async getCurrent(group: string): Promise<Array<JibriState>> {
        const states: Array<JibriState> = [];
        let items: Array<string> = [];

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `instance:status:${group}:*`);
            cursor = result[0];
            if (result[1].length > 0) {
                items = await this.redisClient.mget(...result[1]);
                items.forEach((item) => {
                    states.push(JSON.parse(item));
                });
            }
        } while (cursor != '0');
        this.logger.debug(`jibri states: ${states}`, { group, states });

        return states;
    }
}
