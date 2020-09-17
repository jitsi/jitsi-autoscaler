import Redis from 'ioredis';
import { InstanceState } from './instance_tracker';
import { Context } from './context';

export interface InstanceAudit {
    instanceId: string;
    type: string;
    timestamp: number;
    state?: InstanceState;
}

export interface GroupAudit {
    groupName: string;
    type: string;
    timestamp: number | string;
    autoScalerActionItem?: AutoScalerActionItem;
    launcherActionItem?: LauncherActionItem;
}

export interface AutoScalerActionItem {
    timestamp: number | string;
    actionType: string;
    count: number;
    oldDesiredCount: number;
    newDesiredCount: number;
    scaleMetrics: Array<number>;
}

export interface LauncherActionItem {
    timestamp: number | string;
    actionType: string;
    count: number;
    desiredCount: number;
    scaleQuantity: number;
}

export interface GroupAuditResponse {
    lastLauncherRun: string;
    lastAutoScalerRun: string;
    autoScalerActionItems?: AutoScalerActionItem[];
    launcherActionItems?: LauncherActionItem[];
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
        return this.setInstanceValue(`audit:${groupName}:${instanceId}:latest-status`, value, this.auditTTL);
    }

    async saveLaunchEvent(groupName: string, instanceId: string): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'request-to-launch',
            timestamp: Date.now(),
        };
        return this.setInstanceValue(`audit:${groupName}:${instanceId}:request-to-launch`, value, this.auditTTL);
    }

    async saveShutdownEvent(groupName: string, instanceId: string): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'request-to-terminate',
            timestamp: Date.now(),
        };
        return this.setInstanceValue(`audit:${groupName}:${instanceId}:request-to-terminate`, value, this.auditTTL);
    }

    async setInstanceValue(key: string, value: InstanceAudit, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(value), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async updateLastLauncherRun(groupName: string): Promise<boolean> {
        const value: GroupAudit = {
            groupName: groupName,
            type: 'last-launcher-run',
            timestamp: Date.now(),
        };
        return this.setGroupValue(`audit:${groupName}:last-launcher-run`, value, this.auditTTL);
    }

    async updateLastAutoScalerRun(groupName: string): Promise<boolean> {
        const value: GroupAudit = {
            groupName: groupName,
            type: 'last-autoScaler-run',
            timestamp: Date.now(),
        };
        return this.setGroupValue(`audit:${groupName}:last-autoScaler-run`, value, this.auditTTL);
    }

    async saveLauncherActionItem(groupName: string, launcherActionItem: LauncherActionItem): Promise<boolean> {
        const value: GroupAudit = {
            groupName: groupName,
            type: 'launcher-action-item',
            timestamp: launcherActionItem.timestamp,
            launcherActionItem: launcherActionItem,
        };

        return this.setGroupValue(
            `audit:${groupName}:launcher-action-item:${launcherActionItem.timestamp}`,
            value,
            this.auditTTL,
        );
    }

    async saveAutoScalerActionItem(groupName: string, autoScalerActionItem: AutoScalerActionItem): Promise<boolean> {
        const value: GroupAudit = {
            groupName: groupName,
            type: 'autoScaler-action-item',
            timestamp: autoScalerActionItem.timestamp,
            autoScalerActionItem: autoScalerActionItem,
        };

        return this.setGroupValue(
            `audit:${groupName}:autoScaler-action-item:${autoScalerActionItem.timestamp}`,
            value,
            this.auditTTL,
        );
    }

    async setGroupValue(key: string, value: GroupAudit, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(value), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    async generateInstanceAudit(ctx: Context, groupName: string): Promise<InstanceAuditResponse[]> {
        const instanceAudits: Array<InstanceAudit> = await this.getInstanceAudit(ctx, groupName);
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

    async generateGroupAudit(ctx: Context, groupName: string): Promise<GroupAuditResponse> {
        const groupAudits: Array<GroupAudit> = await this.getGroupAudit(ctx, groupName);

        const groupAuditResponse: GroupAuditResponse = {
            lastLauncherRun: 'unknown',
            lastAutoScalerRun: 'unknown',
        };

        const autoScalerActionItems: AutoScalerActionItem[] = [];
        const launcherActionItems: LauncherActionItem[] = [];
        for (const groupAudit of groupAudits) {
            switch (groupAudit.type) {
                case 'last-launcher-run':
                    groupAuditResponse.lastLauncherRun = new Date(groupAudit.timestamp).toUTCString();
                    break;
                case 'last-autoScaler-run':
                    groupAuditResponse.lastAutoScalerRun = new Date(groupAudit.timestamp).toUTCString();
                    break;
                case 'launcher-action-item':
                    launcherActionItems.push(groupAudit.launcherActionItem);
                    break;
                case 'autoScaler-action-item':
                    autoScalerActionItems.push(groupAudit.autoScalerActionItem);
                    break;
            }
        }
        autoScalerActionItems
            .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))
            .map(function (key) {
                key.timestamp = new Date(key.timestamp).toUTCString();
            });
        launcherActionItems
            .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))
            .map(function (key) {
                key.timestamp = new Date(key.timestamp).toUTCString();
            });

        groupAuditResponse.autoScalerActionItems = autoScalerActionItems;
        groupAuditResponse.launcherActionItems = launcherActionItems;
        return groupAuditResponse;
    }

    async getInstanceAudit(ctx: Context, groupName: string): Promise<Array<InstanceAudit>> {
        const audit: Array<InstanceAudit> = [];
        let items: Array<string> = [];

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(cursor, 'match', `audit:${groupName}:*:*`);
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
        ctx.logger.debug(`Instance audit: `, { groupName, audit });

        return audit;
    }

    async getGroupAudit(ctx: Context, groupName: string): Promise<Array<GroupAudit>> {
        const audit: Array<GroupAudit> = [];
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
