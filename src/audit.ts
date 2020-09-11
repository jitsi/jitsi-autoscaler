import Redis from 'ioredis';
import { InstanceState } from './instance_tracker';
import { Context } from './context';

export interface InstanceAudit {
    instanceId: string;
    type: string;
    timestamp: number;
    state?: InstanceState;
}

export interface InstanceAuditResponse {
    instanceId: string;
    requestToLaunch: string;
    latestStatus: string;
    requestToTerminate: string;
    latestStatusInfo?: InstanceState;
}

export interface AuditOptions {
    redisClient: Redis.Redis;
    auditTTL: number;
}

export default class Audit {
    private redisClient: Redis.Redis;
    private auditTTL: number;

    constructor(options: AuditOptions) {
        this.redisClient = options.redisClient;
        this.auditTTL = options.auditTTL;
    }

    async saveLatestStatus(groupName: string, instanceId: string, instanceState: InstanceState): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'latest-status',
            timestamp: Date.now(),
            state: instanceState,
        };
        return this.setValue(`audit:${groupName}:${instanceId}:latest-status`, value, this.auditTTL);
    }

    async saveLaunchEvent(groupName: string, instanceId: string): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'request-to-launch',
            timestamp: Date.now(),
        };
        return this.setValue(`audit:${groupName}:${instanceId}:request-to-launch`, value, this.auditTTL);
    }

    async saveShutdownEvent(groupName: string, instanceId: string): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'request-to-terminate',
            timestamp: Date.now(),
        };
        return this.setValue(`audit:${groupName}:${instanceId}:request-to-terminate`, value, this.auditTTL);
    }

    async setValue(key: string, value: InstanceAudit, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(value), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async generateAudit(ctx: Context, groupName: string): Promise<InstanceAuditResponse[]> {
        const instanceAudits: Array<InstanceAudit> = await this.getAudit(ctx, groupName);
        instanceAudits.sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

        const instanceAuditResponseList: InstanceAuditResponse[] = [];
        new Set(instanceAudits.map((instanceAudit) => instanceAudit.instanceId)).forEach((instanceId) => {
            const instanceAuditResponse: InstanceAuditResponse = {
                instanceId: instanceId,
                requestToLaunch: 'unknown',
                latestStatus: 'unknown',
                requestToTerminate: 'unknown',
            };
            instanceAuditResponseList.push(instanceAuditResponse);
        });

        instanceAuditResponseList.forEach(function (instanceAuditResponse) {
            for (const instanceAudit of instanceAudits.filter(
                (instanceAudit) => instanceAudit.instanceId == instanceAuditResponse.instanceId,
            )) {
                switch (instanceAudit.type) {
                    case 'request-to-launch':
                        instanceAuditResponse.requestToLaunch = new Date(instanceAudit.timestamp).toUTCString();
                        break;
                    case 'request-to-terminate':
                        instanceAuditResponse.requestToTerminate = new Date(instanceAudit.timestamp).toUTCString();
                        break;
                    case 'latest-status':
                        instanceAuditResponse.latestStatus = new Date(instanceAudit.timestamp).toUTCString();
                        instanceAuditResponse.latestStatusInfo = instanceAudit.state;
                        break;
                }
            }
        });

        return instanceAuditResponseList;
    }

    async getAudit(ctx: Context, groupName: string): Promise<Array<InstanceAudit>> {
        const audit: Array<InstanceAudit> = [];
        let items: Array<string> = [];

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `audit:${groupName}:*`);
            cursor = result[0];
            if (result[1].length > 0) {
                items = await this.redisClient.mget(...result[1]);
                items.forEach((item) => {
                    if (item) {
                        audit.push(JSON.parse(item));
                    }
                });
            }
        } while (cursor != '0');
        ctx.logger.debug(`Group audit: `, { groupName, audit });

        return audit;
    }
}
