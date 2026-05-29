import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerRemoveScheduledScalingPeriod(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'remove_scheduled_scaling_period',
        'Remove a scheduled scaling period from a group by name. If the last period is removed, the scheduled scaling config is preserved but will have no active periods.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group'),
            period_name: z.string().describe('Name of the scheduled scaling period to remove'),
        },
        async (params) => {
            try {
                const c = client.withOverrides(params.base_url, params.auth_token);
                const config = await c.getScheduledScaling(params.name);

                if (!config) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Group '${params.name}' has no scheduled scaling configuration.`,
                            },
                        ],
                        isError: true,
                    };
                }

                const index = config.periods.findIndex((p) => p.name === params.period_name);
                if (index === -1) {
                    const available = config.periods.map((p) => p.name).join(', ');
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Period '${params.period_name}' not found. Available periods: ${
                                    available || 'none'
                                }`,
                            },
                        ],
                        isError: true,
                    };
                }

                config.periods.splice(index, 1);
                await c.updateScheduledScaling(params.name, config);

                const remaining = config.periods.map((p) => p.name).join(', ');
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Removed period '${params.period_name}' from '${params.name}'. Remaining periods: ${
                                remaining || 'none'
                            }`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error removing scheduled scaling period: ${(error as Error).message}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
