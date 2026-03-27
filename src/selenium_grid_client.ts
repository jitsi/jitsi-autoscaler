import { Context } from './context';

export interface SeleniumGridStatus {
    sessionQueueSize: number;
    activeSessions: number;
    maxSessions: number;
    nodeCount: number;
}

export interface SeleniumGridClientOptions {
    fetchTimeoutMs: number;
}

export default class SeleniumGridClient {
    private fetchTimeoutMs: number;

    constructor(options: SeleniumGridClientOptions) {
        this.fetchTimeoutMs = options.fetchTimeoutMs;
    }

    async getGridStatus(ctx: Context, gridUrl: string): Promise<SeleniumGridStatus> {
        const url = gridUrl.endsWith('/status') ? gridUrl : `${gridUrl.replace(/\/+$/, '')}/status`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: 'application/json' },
            });

            if (!response.ok) {
                throw new Error(`Selenium Grid status request failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return this.parseGridResponse(data);
        } catch (err) {
            if (err.name === 'AbortError') {
                ctx.logger.error(`Selenium Grid status request timed out after ${this.fetchTimeoutMs}ms`, { gridUrl });
                throw new Error(`Selenium Grid status request timed out`);
            }
            ctx.logger.error(`Failed to fetch Selenium Grid status`, { gridUrl, err });
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    }

    private parseGridResponse(data: unknown): SeleniumGridStatus {
        // Selenium Grid 4 status response format:
        // { value: { ready: bool, message: string, nodes: [...] } }
        // Session queue info is at: { value: { sessionQueueRequests: [...] } } or via /graphql
        // We handle the standard /status endpoint format

        const value = (data as { value?: unknown })?.value as Record<string, unknown>;
        if (!value) {
            throw new Error('Invalid Selenium Grid status response: missing value field');
        }

        const nodes = (value.nodes as Array<Record<string, unknown>>) || [];
        let activeSessions = 0;
        let maxSessions = 0;

        for (const node of nodes) {
            const slots = (node.slots as Array<Record<string, unknown>>) || [];
            maxSessions += slots.length;
            activeSessions += slots.filter((s) => s.session != null).length;
        }

        // sessionQueueRequests may be an array of queued requests
        const sessionQueue = value.sessionQueueRequests as unknown[] | undefined;
        const sessionQueueSize = sessionQueue ? sessionQueue.length : 0;

        return {
            sessionQueueSize,
            activeSessions,
            maxSessions,
            nodeCount: nodes.length,
        };
    }
}
