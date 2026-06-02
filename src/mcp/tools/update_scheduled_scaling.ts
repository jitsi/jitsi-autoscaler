import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerUpdateScheduledScaling(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'update_scheduled_scaling',
        "Update scheduled scaling config for a group. Without period_name, updates only top-level settings (enabled, timezone). With period_name, also updates that period's scaling overrides.",
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group'),
            period_name: z
                .string()
                .optional()
                .describe('Name of the scheduled scaling period to update. Omit to only change top-level settings.'),
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
            reservationScaleUpThreshold: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                    'selenium-grid only: override the waiting-reserved-nodes threshold for scale-up during this period',
                ),
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

                // Merge top-level config changes
                if (params.enabled !== undefined) config.enabled = params.enabled;
                if (params.timezone !== undefined) config.timezone = params.timezone;

                // If a period is specified, merge scaling overrides into it
                if (params.period_name) {
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

                    const so = period.scalingOptions;
                    if (params.minDesired !== undefined) so.minDesired = params.minDesired;
                    if (params.maxDesired !== undefined) so.maxDesired = params.maxDesired;
                    if (params.desiredCount !== undefined) so.desiredCount = params.desiredCount;
                    if (params.scaleUpThreshold !== undefined) so.scaleUpThreshold = params.scaleUpThreshold;
                    if (params.scaleDownThreshold !== undefined) so.scaleDownThreshold = params.scaleDownThreshold;
                    if (params.scaleUpQuantity !== undefined) so.scaleUpQuantity = params.scaleUpQuantity;
                    if (params.scaleDownQuantity !== undefined) so.scaleDownQuantity = params.scaleDownQuantity;
                    if (params.reservationScaleUpThreshold !== undefined)
                        so.reservationScaleUpThreshold = params.reservationScaleUpThreshold;
                }

                await c.updateScheduledScaling(params.name, config);

                // Build response
                const parts: string[] = [];
                parts.push(`Updated scheduled scaling on '${params.name}':`);
                parts.push(`  enabled=${config.enabled}, timezone=${config.timezone || 'UTC'}`);

                if (params.period_name) {
                    const period = config.periods.find((p) => p.name === params.period_name)!;
                    const so = period.scalingOptions;
                    const optParts: string[] = [];
                    if (so.minDesired !== undefined) optParts.push(`min=${so.minDesired}`);
                    if (so.maxDesired !== undefined) optParts.push(`max=${so.maxDesired}`);
                    if (so.desiredCount !== undefined) optParts.push(`desired=${so.desiredCount}`);
                    if (so.scaleUpThreshold !== undefined) optParts.push(`upThreshold=${so.scaleUpThreshold}`);
                    if (so.scaleDownThreshold !== undefined) optParts.push(`downThreshold=${so.scaleDownThreshold}`);
                    if (so.scaleUpQuantity !== undefined) optParts.push(`upQuantity=${so.scaleUpQuantity}`);
                    if (so.scaleDownQuantity !== undefined) optParts.push(`downQuantity=${so.scaleDownQuantity}`);
                    if (optParts.length > 0) {
                        parts.push(`  Period '${params.period_name}': ${optParts.join(', ')}`);
                    }
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: parts.join('\n'),
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
