import { Context } from './context';

export interface InstanceMetric {
    instanceId: string;
    timestamp: number;
    value: number;
}

interface MetricsStore {
    fetchInstanceMetrics: {
        // windowSeconds is the lookback window the caller needs (scalePeriod * max period count).
        // The Redis implementation ignores it (it stores/cleans by metricTTL); Prometheus uses it to
        // size the range query so long scaling windows are not silently truncated.
        (ctx: Context, group: string, windowSeconds?: number): Promise<InstanceMetric[]>;
    };
    writeInstanceMetric: {
        (ctx: Context, group: string, item: InstanceMetric): Promise<boolean>;
    };
    cleanInstanceMetrics: { (ctx: Context, group: string): Promise<boolean> };
    saveMetricUnTrackedCount: { (ctx: Context, groupName: string, count: number): Promise<boolean> };
}

export default MetricsStore;
