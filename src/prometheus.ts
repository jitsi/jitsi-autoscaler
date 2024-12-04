import * as promClient from 'prom-client';
import { pushMetrics, Result, Options } from 'prometheus-remote-write';
import { PrometheusDriver, QueryResult } from 'prometheus-query';
import MetricsStore, { InstanceMetric } from './metrics_store';
import { Context } from './context';

export interface PromLabels {
    [key: string]: string;
}

export interface PromMetrics {
    [key: string]: number;
}

export interface PrometheusOptions {
    endpoint: string;
    baseURL?: string;
    promDriver?: PrometheusDriver;
    promWriter?: PrometheusWriter;
}

interface PromQueryValue {
    time: string;
    value: number;
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

export class PrometheusWriter {
    private url: string;
    constructor(url = 'localhost:9090/api/v1/write') {
        this.url = url;
    }

    async pushMetrics(metrics: PromMetrics, labels: PromLabels): Promise<Result> {
        const options = <Options>{
            url: this.url,
            labels,
            // verbose: true,
            headers: { 'Content-Type': 'application/x-protobuf' },
        };
        return pushMetrics(metrics, options);
    }
}

export default class PrometheusClient implements MetricsStore {
    private endpoint: string;
    private baseURL = '/api/v1';
    private writeURL = '/api/v1/write';

    private promDriver: PrometheusDriver;
    private promWriter: PrometheusWriter;

    constructor(options: PrometheusOptions) {
        this.endpoint = options.endpoint;
        if (options.baseURL) {
            this.baseURL = options.baseURL;
        }
        if (options.promDriver) {
            this.promDriver = options.promDriver;
        } else {
            this.promDriver = new PrometheusDriver({
                endpoint: this.endpoint,
                baseURL: this.baseURL,
            });
        }
        if (options.promWriter) {
            this.promWriter = options.promWriter;
        } else {
            this.promWriter = new PrometheusWriter(this.endpoint + this.writeURL);
        }
    }

    public async prometheusRangeQuery(ctx: Context, query: string): Promise<QueryResult> {
        const start = new Date().getTime() - 1 * 60 * 60 * 1000;
        const end = new Date();
        const step = 60; // 1 point every minute
        try {
            const qStart = process.hrtime();
            const res = await this.promDriver.rangeQuery(query, start, end, step);
            const qEnd = process.hrtime(qStart);
            promQueryCount.inc();
            promQuerySum.inc(qEnd[0] * 1000 + qEnd[1] / 1000000);

            return res;
        } catch (err) {
            promQueryErrors.inc();
            ctx.logger.error('Error querying Prometheus:', { query, err });
        }
    }

    async pushMetric(ctx: Context, metrics: PromMetrics, labels: PromLabels): Promise<boolean> {
        try {
            const pushStart = process.hrtime();
            const res = await this.promWriter.pushMetrics(metrics, labels);
            const pushEnd = process.hrtime(pushStart);

            if (res.status !== 204) {
                promWriteErrors.inc();
                ctx.logger.error('Returned status != 204 while pushing metrics to Prometheus:', res);
            } else {
                promWriteCount.inc();
                promWriteSum.inc(pushEnd[0] * 1000 + pushEnd[1] / 1000000);
                return true;
            }
        } catch (err) {
            promWriteErrors.inc();
            ctx.logger.error('Error pushing metrics to Prometheus:', err);
        }
        return false;
    }

    async fetchInstanceMetrics(ctx: Context, group: string): Promise<InstanceMetric[]> {
        const query = `autoscaler_instance_stress_level{group="${group}"}`;
        const metricItems: InstanceMetric[] = [];
        try {
            const res = await this.prometheusRangeQuery(ctx, query);
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
            ctx.logger.error('Error fetching instance metrics:', { group, err });
        }
        return metricItems;
    }

    async writeInstanceMetric(ctx: Context, group: string, item: InstanceMetric): Promise<boolean> {
        const labels = { instance: item.instanceId, group };
        const metrics = { autoscaler_instance_stress_level: item.value };
        return this.pushMetric(ctx, metrics, labels);
    }

    saveMetricUnTrackedCount(ctx: Context, groupName: string, count: number): Promise<boolean> {
        const metrics = { autoscaler_untracked_instance_count: count };
        const labels = { group: groupName };
        return this.pushMetric(ctx, metrics, labels);
    }

    async cleanInstanceMetrics(_ctx: Context, _group: string): Promise<boolean> {
        return true;
    }
}
