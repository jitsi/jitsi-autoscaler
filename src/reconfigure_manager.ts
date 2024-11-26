import { Redis } from 'ioredis';
import { Context } from './context';
import Audit from './audit';
import { StatsReport } from './instance_tracker';
import { InstanceDetails } from './instance_store';

export interface ReconfigureManagerOptions {
    redisClient: Redis;
    reconfigureTTL: number;
    audit: Audit;
}

export default class ReconfigureManager {
    private redisClient: Redis;
    private reconfigureTTL: number;
    private audit: Audit;

    constructor(options: ReconfigureManagerOptions) {
        this.redisClient = options.redisClient;
        this.reconfigureTTL = options.reconfigureTTL;
        this.audit = options.audit;
    }

    reconfigureKey(instanceId: string): string {
        return `instance:reconfigure:${instanceId}`;
    }

    async setReconfigureDate(ctx: Context, instanceDetails: InstanceDetails[]): Promise<boolean> {
        const reconfigureDate = new Date().toISOString();
        const pipeline = this.redisClient.pipeline();
        for (const instance of instanceDetails) {
            const key = this.reconfigureKey(instance.instanceId);
            ctx.logger.debug('Writing reconfigure date', { key, reconfigureDate });
            pipeline.set(key, reconfigureDate, 'EX', this.reconfigureTTL);
        }
        await pipeline.exec();
        await this.audit.saveReconfigureEvents(instanceDetails);
        return true;
    }

    async unsetReconfigureDate(ctx: Context, instanceId: string, group: string): Promise<boolean> {
        const key = this.reconfigureKey(instanceId);
        const res = await this.redisClient.del(key);
        ctx.logger.debug('Remove reconfigure value', { key, res });
        await this.audit.saveUnsetReconfigureEvents(instanceId, group);
        return true;
    }

    async getReconfigureDates(ctx: Context, instanceIds: Array<string>): Promise<string[]> {
        const pipeline = this.redisClient.pipeline();
        instanceIds.forEach((instanceId) => {
            const key = this.reconfigureKey(instanceId);
            pipeline.get(key);
        });
        const instances = await pipeline.exec();
        if (instances) {
            return instances.map((instance: [error: Error | null, result: unknown]) => {
                return <string>instance[1];
            });
        } else {
            ctx.logger.error('ReconfigureDates Failed in pipeline.exec()');
            return [];
        }
    }

    async getReconfigureDate(ctx: Context, instanceId: string): Promise<string> {
        const key = this.reconfigureKey(instanceId);
        const res = await this.redisClient.get(key);
        ctx.logger.debug('Read reconfigure value', { key, res });
        return res;
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
