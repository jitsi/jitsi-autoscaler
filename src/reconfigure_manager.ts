import { Context } from './context';
import Audit from './audit';
import { StatsReport } from './instance_tracker';
import InstanceStore, { InstanceDetails } from './instance_store';

export interface ReconfigureManagerOptions {
    instanceStore: InstanceStore;
    reconfigureTTL: number;
    audit: Audit;
}

export default class ReconfigureManager {
    private instanceStore: InstanceStore;
    private reconfigureTTL: number;
    private audit: Audit;

    constructor(options: ReconfigureManagerOptions) {
        this.instanceStore = options.instanceStore;
        this.reconfigureTTL = options.reconfigureTTL;
        this.audit = options.audit;
    }

    async setReconfigureDate(ctx: Context, instanceDetails: InstanceDetails[]): Promise<boolean> {
        const reconfigureDate = new Date().toISOString();
        const save = this.instanceStore.setReconfigureDate(ctx, instanceDetails, reconfigureDate, this.reconfigureTTL);
        await this.audit.saveReconfigureEvents(instanceDetails);
        return save;
    }

    async unsetReconfigureDate(ctx: Context, instanceId: string, group: string): Promise<boolean> {
        const save = this.instanceStore.unsetReconfigureDate(ctx, instanceId, group);
        await this.audit.saveUnsetReconfigureEvents(instanceId, group);
        return save;
    }

    async getReconfigureDates(ctx: Context, group: string, instanceIds: string[]): Promise<string[]> {
        return this.instanceStore.getReconfigureDates(ctx, group, instanceIds);
    }

    async getReconfigureDate(ctx: Context, group: string, instanceId: string): Promise<string> {
        return this.instanceStore.getReconfigureDate(ctx, group, instanceId);
    }

    async processInstanceReport(ctx: Context, report: StatsReport, reconfigureDate: string): Promise<string> {
        let returnReconfigureDate = reconfigureDate;

        if (reconfigureDate && report.reconfigureComplete) {
            const dLast = new Date(report.reconfigureComplete);
            const dValue = new Date(reconfigureDate);
            if (dLast >= dValue) {
                ctx.logger.debug('Reconfiguration found after scheduled date, unsetting reconfiguration', {
                    reconfigureDate,
                    reconfigureComplete: report.reconfigureComplete,
                });
                await this.unsetReconfigureDate(ctx, report.instance.instanceId, report.instance.group);
                returnReconfigureDate = '';
            }
        }
        return returnReconfigureDate;
    }
}
