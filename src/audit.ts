import Redis from 'ioredis';
import { InstanceDetails, InstanceState } from './instance_tracker';
import { Context } from './context';
import { JobType } from './job_manager';

export interface InstanceAudit {
    instanceId: string;
    type: string;
    timestamp: number;
    state?: InstanceState;
}

export interface GroupAudit {
    groupName: string;
    type: string;
    timestamp?: number | string;
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
    redisScanCount: number;
    auditTTL: number;
    groupRelatedDataTTL: number;
}

export default class Audit {
    private redisClient: Redis.Redis;
    private readonly redisScanCount: number;
    private readonly auditTTL: number;
    private readonly groupRelatedDataTTL: number;

    constructor(options: AuditOptions) {
        this.redisClient = options.redisClient;
        this.redisScanCount = options.redisScanCount;
        this.auditTTL = options.auditTTL;
        this.groupRelatedDataTTL = options.groupRelatedDataTTL;
    }

    async saveLatestStatus(groupName: string, instanceId: string, instanceState: InstanceState): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'latest-status',
            timestamp: Date.now(),
            state: instanceState,
        };
        const latestStatusSaved = this.setInstanceValue(
            `audit:${groupName}:${instanceId}:latest-status`,
            value,
            this.auditTTL,
        );
        if (latestStatusSaved) {
            this.increaseLaunchEventExpiration(groupName, instanceId);
            this.increaseShutdownEventExpiration(groupName, instanceId);
        }
        return latestStatusSaved;
    }

    async saveLaunchEvent(groupName: string, instanceId: string): Promise<boolean> {
        const value: InstanceAudit = {
            instanceId: instanceId,
            type: 'request-to-launch',
            timestamp: Date.now(),
        };
        return this.setInstanceValue(`audit:${groupName}:${instanceId}:request-to-launch`, value, this.auditTTL);
    }

    private async increaseLaunchEventExpiration(groupName: string, instanceId: string): Promise<boolean> {
        // we don't care if this fails (e.g. perhaps the event no longer is there)
        const result = await this.redisClient.expire(
            `audit:${groupName}:${instanceId}:request-to-launch`,
            this.auditTTL,
        );
        return result == 1;
    }

    async saveShutdownEvents(instanceDetails: Array<InstanceDetails>): Promise<void> {
        const pipeline = this.redisClient.pipeline();
        for (const instance of instanceDetails) {
            const value: InstanceAudit = {
                instanceId: instance.instanceId,
                type: 'request-to-terminate',
                timestamp: Date.now(),
            };
            pipeline.set(
                `audit:${instance.group}:${instance.instanceId}:request-to-terminate`,
                JSON.stringify(value),
                'ex',
                this.auditTTL,
            );
        }
        await pipeline.exec();
    }

    private async increaseShutdownEventExpiration(groupName: string, instanceId: string): Promise<boolean> {
        // we don't care if this fails (e.g. perhaps the event no longer is there)
        const result = await this.redisClient.expire(
            `audit:${groupName}:${instanceId}:request-to-terminate`,
            this.auditTTL,
        );
        return result == 1;
    }

    async setInstanceValue(key: string, value: InstanceAudit, ttl: number): Promise<boolean> {
        const result = await this.redisClient.set(key, JSON.stringify(value), 'ex', ttl);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    private getGroupAuditActionsKey(groupName: string): string {
        return `group-audit-actions:${groupName}`;
    }

    private async extendTTLForKey(key: string, ttl: number): Promise<boolean> {
        const result = await this.redisClient.expire(key, ttl);
        return result == 1;
    }

    private async setGroupValue(groupName: string, value: GroupAudit): Promise<boolean> {
        let timestamp = value.timestamp;
        if (!timestamp) {
            timestamp = Date.now();
        }
        await this.redisClient.zadd(this.getGroupAuditActionsKey(groupName), timestamp, JSON.stringify(value));
        return true;
    }

    async updateLastLauncherRun(ctx: Context, groupName: string): Promise<boolean> {
        const updateLastLaunchStart = process.hrtime();

        // Extend TTL longer enough for the key to be deleted only after the group is deleted or no action is performed on it
        await this.extendTTLForKey(this.getGroupAuditActionsKey(groupName), this.groupRelatedDataTTL);
        await this.cleanupGroupActionsAudit(ctx, groupName);

        const value: GroupAudit = {
            groupName: groupName,
            type: 'last-launcher-run',
            timestamp: Date.now(),
        };
        this.setLastRunValue(groupName, JobType.Launch, value);

        const updateLastLaunchEnd = process.hrtime(updateLastLaunchStart);
        ctx.logger.info(
            `Updated last launcher run in ${
                updateLastLaunchEnd[0] * 1000 + updateLastLaunchEnd[1] / 1000000
            } ms, for group ${groupName}`,
        );

        return true;
    }

    async updateLastAutoScalerRun(ctx: Context, groupName: string): Promise<boolean> {
        const updateLastAutoScalerStart = process.hrtime();

        // Extend TTL longer enough for the key to be deleted only after the group is deleted or no action is performed on it
        await this.extendTTLForKey(this.getGroupAuditActionsKey(groupName), this.groupRelatedDataTTL);
        await this.cleanupGroupActionsAudit(ctx, groupName);

        const value: GroupAudit = {
            groupName: groupName,
            type: 'last-autoScaler-run',
            timestamp: Date.now(),
        };
        this.setLastRunValue(groupName, JobType.Autoscale, value);

        const updateLastAutoScalerEnd = process.hrtime(updateLastAutoScalerStart);
        ctx.logger.info(
            `Updated last autoScaler run in ${
                updateLastAutoScalerEnd[0] * 1000 + updateLastAutoScalerEnd[1] / 1000000
            } ms, for group ${groupName}`,
        );

        return true;
    }

    async getSecondsSinceLastAutoscaleRun(groupName: string): Promise<number> {
        return await this.getSecondsSinceLastRun(groupName, JobType.Autoscale);
    }

    async getSecondsSinceLastLauncherRun(groupName: string): Promise<number> {
        return await this.getSecondsSinceLastRun(groupName, JobType.Launch);
    }

    private async setLastRunValue(group: string, jobType: JobType, value: GroupAudit): Promise<boolean> {
        const key = `last-${jobType}-run:${group}`;
        const result = await this.redisClient.set(key, JSON.stringify(value), 'ex', this.auditTTL);
        if (result !== 'OK') {
            throw new Error(`unable to set ${key}`);
        }
        return true;
    }

    private async getLastRunValue(group: string, jobType: JobType): Promise<GroupAudit> {
        const key = `last-${jobType}-run:${group}`;
        const result = await this.redisClient.get(key);
        if (result !== null && result.length > 0) {
            return JSON.parse(result);
        } else {
            return null;
        }
    }

    private async getSecondsSinceLastRun(group: string, jobType: JobType): Promise<number> {
        const groupAudit: GroupAudit = await this.getLastRunValue(group, jobType);
        if (groupAudit && groupAudit.timestamp) {
            const now = Date.now();
            const diffMs = now - Number(groupAudit.timestamp);
            return diffMs / 1000;
        } else {
            return null;
        }
    }

    private async cleanupGroupActionsAudit(ctx: Context, groupName: string): Promise<boolean> {
        const currentTime = Date.now();
        const cleanupUntil = new Date(currentTime - 1000 * this.auditTTL).getTime();

        const cleanupStart = process.hrtime();
        const itemsCleanedUp: number = await this.redisClient.zremrangebyscore(
            this.getGroupAuditActionsKey(groupName),
            0,
            cleanupUntil,
        );
        const cleanupEnd = process.hrtime(cleanupStart);
        ctx.logger.info(
            `Cleaned up ${itemsCleanedUp} group audit actions in ${
                cleanupEnd[0] * 1000 + cleanupEnd[1] / 1000000
            } ms, for group ${groupName}`,
        );
        return true;
    }

    async saveLauncherActionItem(groupName: string, launcherActionItem: LauncherActionItem): Promise<boolean> {
        const value: GroupAudit = {
            groupName: groupName,
            type: 'launcher-action-item',
            timestamp: launcherActionItem.timestamp,
            launcherActionItem: launcherActionItem,
        };

        return this.setGroupValue(groupName, value);
    }

    async saveAutoScalerActionItem(groupName: string, autoScalerActionItem: AutoScalerActionItem): Promise<boolean> {
        const value: GroupAudit = {
            groupName: groupName,
            type: 'autoScaler-action-item',
            timestamp: autoScalerActionItem.timestamp,
            autoScalerActionItem: autoScalerActionItem,
        };

        return this.setGroupValue(groupName, value);
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
        const groupActionsAudits: Array<GroupAudit> = await this.getGroupActionsAudit(ctx, groupName);

        const groupAuditResponse: GroupAuditResponse = {
            lastLauncherRun: 'unknown',
            lastAutoScalerRun: 'unknown',
        };

        const lastLauncherRun: GroupAudit = await this.getLastRunValue(groupName, JobType.Launch);
        if (lastLauncherRun) {
            groupAuditResponse.lastLauncherRun = new Date(lastLauncherRun.timestamp).toUTCString();
        }

        const lastAutoscalerRun: GroupAudit = await this.getLastRunValue(groupName, JobType.Autoscale);
        if (lastAutoscalerRun) {
            groupAuditResponse.lastAutoScalerRun = new Date(lastAutoscalerRun.timestamp).toUTCString();
        }

        const autoScalerActionItems: AutoScalerActionItem[] = [];
        const launcherActionItems: LauncherActionItem[] = [];
        for (const groupActionAudit of groupActionsAudits) {
            switch (groupActionAudit.type) {
                case 'launcher-action-item':
                    launcherActionItems.push(groupActionAudit.launcherActionItem);
                    break;
                case 'autoScaler-action-item':
                    autoScalerActionItems.push(groupActionAudit.autoScalerActionItem);
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

        let cursor = '0';
        do {
            const result = await this.redisClient.scan(
                cursor,
                'match',
                `audit:${groupName}:*:*`,
                'count',
                this.redisScanCount,
            );
            cursor = result[0];
            if (result[1].length > 0) {
                const pipeline = this.redisClient.pipeline();
                result[1].forEach((key: string) => {
                    pipeline.get(key);
                });

                const items = await pipeline.exec();
                items.forEach((item) => {
                    if (item[1]) {
                        audit.push(JSON.parse(item[1]));
                    }
                });
            }
        } while (cursor != '0');
        ctx.logger.debug(`Instance audit: `, { groupName, audit });

        return audit;
    }

    async getGroupActionsAudit(ctx: Context, groupName: string): Promise<Array<GroupAudit>> {
        const audit: Array<GroupAudit> = [];

        const groupAuditStart = process.hrtime();
        const items: string[] = await this.redisClient.zrange(this.getGroupAuditActionsKey(groupName), 0, -1);
        for (const item of items) {
            if (item) {
                const groupAudit: GroupAudit = JSON.parse(item);
                if (!groupAudit.timestamp) {
                    const scoreAsTimestamp = await this.redisClient.zscore(
                        this.getGroupAuditActionsKey(groupName),
                        JSON.stringify(groupAudit),
                    );
                    groupAudit.timestamp = Number(scoreAsTimestamp);
                }
                audit.push(groupAudit);
            }
        }
        const groupAuditEnd = process.hrtime(groupAuditStart);

        ctx.logger.info(
            `Returned ${items.length} group audit actions in ${
                groupAuditEnd[0] * 1000 + groupAuditEnd[1] / 1000000
            } ms, for group ${groupName}`,
        );

        return audit;
    }
}
