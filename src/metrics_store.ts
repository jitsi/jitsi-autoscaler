import { Context } from './context';

export interface InstanceMetric {
    instanceId: string;
    timestamp: number;
    value: number;
}

interface CleanInstanceMetrics {
    (ctx: Context, group: string): Promise<boolean>;
}

interface FetchInstanceMetrics {
    (ctx: Context, group: string): Promise<InstanceMetric[]>;
}

interface WriteInstanceMetric {
    (ctx: Context, group: string, item: InstanceMetric): Promise<boolean>;
}

interface MetricsStore {
    fetchInstanceMetrics: FetchInstanceMetrics;
    writeInstanceMetric: WriteInstanceMetric;
    cleanInstanceMetrics: CleanInstanceMetrics;
}

export default MetricsStore;
