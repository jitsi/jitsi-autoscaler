import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerUpdateScheduledScaling(server: McpServer, client: AutoscalerApiClient): void {
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'update_scheduled_scaling',
        'Update the scaling overrides of a specific scheduled scaling period for a group. Fetches the current config, merges changes into the named period, and saves.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group'),
            period_name: z.string().describe('Name of the scheduled scaling period to update'),
            enabled: z
                .boolean()
                .optional()
                .describe('Enable or disable scheduled scaling for the group (top-level toggle)'),
            timezone: z.string().optional().describe('Timezone for the schedule (e.g. UTC, America/New_York)'),
            minDesired: z.number().optional().describe('Override minimum desired count during this period'),
            maxDesired: z.number().optional().describe('Override maximum desired count during this period'),
            desiredCount: z.number().optional().describe('Override desired count during this period'),
            scaleUpThreshold: z.number().optional().describe('Override scale up threshold during this period'),
            scaleDownThreshold: z.number().optional().describe('Override scale down threshold during this period'),
            scaleUpQuantity: z.number().optional().describe('Override scale up quantity during this period'),
            scaleDownQuantity: z.number().optional().describe('Override scale down quantity during this period'),
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

                const period = config.periods.find((p) => p.name === params.period_name);
                if (!period) {
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

                // Merge top-level config changes
                if (params.enabled !== undefined) config.enabled = params.enabled;
                if (params.timezone !== undefined) config.timezone = params.timezone;

                // Merge scaling overrides into the period
                const so = period.scalingOptions;
                if (params.minDesired !== undefined) so.minDesired = params.minDesired;
                if (params.maxDesired !== undefined) so.maxDesired = params.maxDesired;
                if (params.desiredCount !== undefined) so.desiredCount = params.desiredCount;
                if (params.scaleUpThreshold !== undefined) so.scaleUpThreshold = params.scaleUpThreshold;
                if (params.scaleDownThreshold !== undefined) so.scaleDownThreshold = params.scaleDownThreshold;
                if (params.scaleUpQuantity !== undefined) so.scaleUpQuantity = params.scaleUpQuantity;
                if (params.scaleDownQuantity !== undefined) so.scaleDownQuantity = params.scaleDownQuantity;

                await c.updateScheduledScaling(params.name, config);

                // Build summary of the updated overrides
                const optParts: string[] = [];
                if (so.minDesired !== undefined) optParts.push(`min=${so.minDesired}`);
                if (so.maxDesired !== undefined) optParts.push(`max=${so.maxDesired}`);
                if (so.desiredCount !== undefined) optParts.push(`desired=${so.desiredCount}`);
                if (so.scaleUpThreshold !== undefined) optParts.push(`upThreshold=${so.scaleUpThreshold}`);
                if (so.scaleDownThreshold !== undefined) optParts.push(`downThreshold=${so.scaleDownThreshold}`);
                if (so.scaleUpQuantity !== undefined) optParts.push(`upQuantity=${so.scaleUpQuantity}`);
                if (so.scaleDownQuantity !== undefined) optParts.push(`downQuantity=${so.scaleDownQuantity}`);

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Updated period '${params.period_name}' on '${params.name}': ${optParts.join(', ')}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error updating scheduled scaling: ${(error as Error).message}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
