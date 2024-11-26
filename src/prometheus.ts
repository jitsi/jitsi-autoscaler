import * as promClient from 'prom-client';
import { pushMetrics, Result, Options } from 'prometheus-remote-write';
import { PrometheusDriver, QueryResult } from 'prometheus-query';
import { Logger } from 'winston';
import MetricsStore, { InstanceMetric } from './metrics_store';
import { Context } from './context';

export interface PromLabels {
    [key: string]: string;
}

export interface PromMetrics {
    [key: string]: number;
}

export interface PrometheusOptions {
    logger: Logger;
    endpoint: string;
    baseURL?: string;
}

interface PromQueryValue {
    time: string;
    value: number;
}

interface PrometheusWriter {
    pushMetrics: (metrics: PromMetrics, options: Options) => Promise<Result>;
}

//metrics for prometheus query
const promQueryErrors = new promClient.Counter({
    name: 'autoscaler_prom_query_errors',
    help: 'Counter for high level prometheus query errors',
});

const promQueryCount = new promClient.Counter({
    name: 'autoscaler_prom_query_count',
    help: 'Counter for high level prometheus query count',
});

const promQuerySum = new promClient.Counter({
    name: 'autoscaler_prom_query_sum',
    help: 'Sum of timings for high level prometheus query',
});

//metrics for prometheus remote write
const promWriteErrors = new promClient.Counter({
    name: 'autoscaler_prom_remote_write_errors',
    help: 'Counter for high level prometheus remote write errors',
});

const promWriteCount = new promClient.Counter({
    name: 'autoscaler_prom_remote_write_count',
    help: 'Counter for high level prometheus remote write errors',
});

const promWriteSum = new promClient.Counter({
    name: 'autoscaler_prom_remote_write_sum',
    help: 'Sum of timings for high level prometheus remote write',
});

export default class PrometheusClient implements MetricsStore {
    private logger: Logger;
    private endpoint: string;
    private baseURL = '/api/v1';
    private writeURL = '/api/v1/write';

    constructor(options: PrometheusOptions) {
        this.logger = options.logger;
        this.endpoint = options.endpoint;
        if (options.baseURL) {
            this.baseURL = options.baseURL;
        }
    }

    prometheusDriver(): PrometheusDriver {
        return new PrometheusDriver({
            endpoint: this.endpoint,
            baseURL: this.baseURL,
        });
    }

    prometheusWriter(): PrometheusWriter {
        return {
            pushMetrics(metrics: PromMetrics, options: Options): Promise<Result> {
                return pushMetrics(metrics, options);
            },
        };
    }

    public async prometheusRangeQuery(query: string, driver = <PrometheusDriver>{}): Promise<QueryResult> {
        if (!driver) driver = this.prometheusDriver();
        const start = new Date().getTime() - 1 * 60 * 60 * 1000;
        const end = new Date();
        const step = 60; // 1 point every minute
        try {
            const qStart = process.hrtime();
            const res = await driver.rangeQuery(query, start, end, step);
            const qEnd = process.hrtime(qStart);
            promQueryCount.inc();
            promQuerySum.inc(qEnd[0] * 1000 + qEnd[1] / 1000000);

            return res;
        } catch (err) {
            promQueryErrors.inc();
            this.logger.error('Error querying Prometheus:', { query, err });
        }
    }

    async pushMetric(metrics: PromMetrics, labels: PromLabels, writer: PrometheusWriter): Promise<boolean> {
        if (!writer) writer = this.prometheusWriter();
        const pushUrl = this.endpoint + this.writeURL;
        try {
            const options = {
                url: pushUrl,
                labels,
                // verbose: true,
                headers: { 'Content-Type': 'application/x-protobuf' },
            };
            const pushStart = process.hrtime();
            const res = await writer.pushMetrics(metrics, options);
            const pushEnd = process.hrtime(pushStart);

            if (res.status !== 204) {
                promWriteErrors.inc();
                this.logger.error('Returned status != 204 while pushing metrics to Prometheus:', res);
            } else {
                promWriteCount.inc();
                promWriteSum.inc(pushEnd[0] * 1000 + pushEnd[1] / 1000000);
                return true;
            }
        } catch (err) {
            promWriteErrors.inc();
            this.logger.error('Error pushing metrics to Prometheus:', err);
        }
        return false;
    }

    async fetchInstanceMetrics(ctx: Context, group: string, driver = <PrometheusDriver>{}): Promise<InstanceMetric[]> {
        const query = `autoscaler_instance_stress_level{group="${group}"}`;
        const metricItems: InstanceMetric[] = [];
        try {
            const res = await this.prometheusRangeQuery(query, driver);
            res.result.forEach((promItem) => {
                promItem.values.forEach((v: PromQueryValue) => {
                    metricItems.push(<InstanceMetric>{
                        value: v.value,
                        timestamp: new Date(v.time).getTime(),
                        instanceId: promItem.metric.labels.instance,
                    });
                });
            });
        } catch (err) {
            this.logger.error('Error fetching instance metrics:', { group, err });
        }
        return metricItems;
    }

    async writeInstanceMetric(
        ctx: Context,
        group: string,
        item: InstanceMetric,
        writer = <PrometheusWriter>{},
    ): Promise<boolean> {
        const labels = { instance: item.instanceId, group };
        const metrics = { autoscaler_instance_stress_level: item.value };
        return this.pushMetric(metrics, labels, writer);
    }

    saveMetricUnTrackedCount(groupName: string, count: number, writer = <PrometheusWriter>{}): Promise<boolean> {
        const metrics = { autoscaler_untracked_instance_count: count };
        const labels = { group: groupName };
        return this.pushMetric(metrics, labels, writer);
    }

    async cleanInstanceMetrics(_ctx: Context, _group: string): Promise<boolean> {
        return true;
    }
}
