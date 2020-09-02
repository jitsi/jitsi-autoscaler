import { Context } from './context';
import * as promClient from 'prom-client';
import GroupReportGenerator from './group_report';

const untrackedInstancesCountCloud = new promClient.Gauge({
    name: 'untracked_instance_count',
    help: 'Gauge for current untracked instances',
    labelNames: ['group'],
});

const instancesCountCloud = new promClient.Gauge({
    name: 'cloud_instance_count',
    help: 'Gauge for current instances in cloud',
    labelNames: ['group'],
});

export interface SanityLoopOptions {
    groupReportGenerator: GroupReportGenerator;
}

export default class SanityLoop {
    private groupReportGenerator: GroupReportGenerator;

    constructor(options: SanityLoopOptions) {
        this.groupReportGenerator = options.groupReportGenerator;
        this.reportUntrackedInstances = this.reportUntrackedInstances.bind(this);
    }

    async reportUntrackedInstances(ctx: Context, groupName: string): Promise<boolean> {
        const groupReport = await this.groupReportGenerator.generateReport(ctx, groupName);
        instancesCountCloud.set({ group: groupName }, groupReport.cloudCount);
        untrackedInstancesCountCloud.set({ group: groupName }, groupReport.unTrackedCount);

        return true;
    }
}
