import { Context } from './context';

export interface InstanceMetric {
    instanceId: string;
    timestamp: number;
    value: number;
}

interface MetricsStore {
    fetchInstanceMetrics: {
        (ctx: Context, group: string): Promise<InstanceMetric[]>;
    };
    writeInstanceMetric: {
        (ctx: Context, group: string, item: InstanceMetric): Promise<boolean>;
    };
    cleanInstanceMetrics: { (ctx: Context, group: string): Promise<boolean> };
    saveMetricUnTrackedCount: { (groupName: string, count: number): Promise<boolean> };
}

export default MetricsStore;
