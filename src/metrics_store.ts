import { Context } from './context';

export interface InstanceMetric {
    instanceId: string;
    timestamp: number;
    value: number;
}

interface MetricsStore {
    fetchInstanceMetrics: {
        // windowSeconds is the lookback window the caller needs (scalePeriod * max period count) and
        // stepSeconds is the desired resolution (the group's scalePeriod). The Redis implementation
        // ignores both (it stores/cleans by metricTTL); Prometheus uses them to size the range query so
        // long scaling windows are not truncated and sub-60s scalePeriods keep per-period resolution.
        (ctx: Context, group: string, windowSeconds?: number, stepSeconds?: number): Promise<InstanceMetric[]>;
    };
    writeInstanceMetric: {
        (ctx: Context, group: string, item: InstanceMetric): Promise<boolean>;
    };
    cleanInstanceMetrics: { (ctx: Context, group: string): Promise<boolean> };
    saveMetricUnTrackedCount: { (ctx: Context, groupName: string, count: number): Promise<boolean> };
}

export default MetricsStore;
