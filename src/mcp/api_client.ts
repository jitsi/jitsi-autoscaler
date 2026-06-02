import { InstanceGroup, ScheduledScalingConfig } from '../instance_store';
import { GroupReport } from '../group_report';
import { GroupAuditResponse, InstanceAuditResponse } from '../audit';

export class AutoscalerApiClient {
    private baseUrl: string;
    private authToken: string;

    constructor(baseUrl: string, authToken: string) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.authToken = authToken;
    }

    /**
     * Returns a new client with overridden base URL and/or auth token.
     * If neither override is provided, returns this client unchanged.
     */
    withOverrides(baseUrl: string | undefined, authToken: string | undefined): AutoscalerApiClient {
        if (!baseUrl && !authToken) return this;
        return new AutoscalerApiClient(baseUrl || this.baseUrl, authToken || this.authToken);
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
        };

        const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return (await response.json()) as T;
        }
        return undefined as unknown as T;
    }

    private async requestOrNull<T>(method: string, path: string): Promise<T | null> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
        };

        const response = await fetch(url, { method, headers });

        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
        }

        return (await response.json()) as T;
    }

    async listGroups(tags?: Record<string, string>): Promise<InstanceGroup[]> {
        const params = new URLSearchParams();
        if (tags) {
            for (const [key, value] of Object.entries(tags)) {
                params.set(`tag.${key}`, value);
            }
        }
        const query = params.toString();
        const path = query ? `/groups?${query}` : '/groups';
        const resp = await this.request<{ instanceGroups: InstanceGroup[] }>('GET', path);
        return resp.instanceGroups;
    }

    async getGroup(name: string): Promise<InstanceGroup | null> {
        const resp = await this.requestOrNull<{ instanceGroup: InstanceGroup }>(
            'GET',
            `/groups/${encodeURIComponent(name)}`,
        );
        return resp?.instanceGroup ?? null;
    }

    async upsertGroup(name: string, group: InstanceGroup): Promise<void> {
        await this.request<void>('PUT', `/groups/${encodeURIComponent(name)}`, group);
    }

    async deleteGroup(name: string): Promise<void> {
        await this.request<void>('DELETE', `/groups/${encodeURIComponent(name)}`);
    }

    async updateDesiredCount(
        name: string,
        values: { minDesired?: number; maxDesired?: number; desiredCount?: number },
    ): Promise<void> {
        await this.request<void>('PUT', `/groups/${encodeURIComponent(name)}/desired`, values);
    }

    async updateScalingOptions(
        name: string,
        options: {
            scaleUpQuantity?: number;
            scaleDownQuantity?: number;
            scaleUpThreshold?: number;
            scaleDownThreshold?: number;
            scalePeriod?: number;
            scaleUpPeriodsCount?: number;
            scaleDownPeriodsCount?: number;
        },
    ): Promise<void> {
        await this.request<void>('PUT', `/groups/${encodeURIComponent(name)}/scaling-options`, options);
    }

    async updateScalingActivities(
        name: string,
        activities: {
            enableAutoScale?: boolean;
            enableLaunch?: boolean;
            enableScheduler?: boolean;
            enableUntrackedThrottle?: boolean;
            enableReconfiguration?: boolean;
        },
    ): Promise<void> {
        await this.request<void>('PUT', `/groups/${encodeURIComponent(name)}/scaling-activities`, activities);
    }

    async getGroupReport(name: string): Promise<GroupReport | null> {
        const resp = await this.requestOrNull<{ groupReport: GroupReport }>(
            'GET',
            `/groups/${encodeURIComponent(name)}/report`,
        );
        return resp?.groupReport ?? null;
    }

    async getGroupAudit(name: string): Promise<GroupAuditResponse | null> {
        const resp = await this.requestOrNull<{ audit: GroupAuditResponse }>(
            'GET',
            `/groups/${encodeURIComponent(name)}/group-audit`,
        );
        return resp?.audit ?? null;
    }

    async getInstanceAudit(name: string): Promise<InstanceAuditResponse[] | null> {
        const resp = await this.requestOrNull<{ audit: InstanceAuditResponse[] }>(
            'GET',
            `/groups/${encodeURIComponent(name)}/instance-audit`,
        );
        return resp?.audit ?? null;
    }

    async getScheduledScaling(name: string): Promise<ScheduledScalingConfig | null> {
        const resp = await this.requestOrNull<{ scheduledScaling: ScheduledScalingConfig | null }>(
            'GET',
            `/groups/${encodeURIComponent(name)}/scheduled-scaling`,
        );
        return resp?.scheduledScaling ?? null;
    }

    async updateScheduledScaling(name: string, config: ScheduledScalingConfig): Promise<void> {
        await this.request<void>('PUT', `/groups/${encodeURIComponent(name)}/scheduled-scaling`, config);
    }
}
