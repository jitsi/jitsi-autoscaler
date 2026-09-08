import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';
import { NON_IDEMPOTENT_WRITE } from './annotations';

export function registerAddScheduledScalingPeriod(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'add_scheduled_scaling_period',
        [
            'Add a new scheduled scaling period to a group. Creates the scheduled scaling config if the group does not have one yet.',
            'Note: when a new config is created with enabled=true (the default), scheduled scaling takes over for the group:',
            'the legacy enableScheduler flag is turned off, and if the new period is active right now its scaling overrides',
            'are applied to the group immediately.',
        ].join(' '),
        {
            name: z.string().describe('Name of the instance group'),
            period_name: z.string().describe('Name for the new scheduled scaling period'),
            dayOfWeek: z
                .array(z.number().int().min(0).max(6))
                .describe('Days of week (0=Sunday, 1=Monday, ..., 6=Saturday)'),
            startHour: z.number().int().min(0).max(23).describe('Start hour (0-23)'),
            startMinute: z.number().int().min(0).max(59).optional().describe('Start minute (0-59, default 0)'),
            endHour: z.number().int().min(0).max(23).describe('End hour (0-23)'),
            endMinute: z.number().int().min(0).max(59).optional().describe('End minute (0-59, default 0)'),
            priority: z.number().int().optional().describe('Priority for overlapping periods (higher wins, default 1)'),
            inhibitScaleDown: z.boolean().optional().describe('Prevent scale-down during this period'),
            timezone: z
                .string()
                .optional()
                .describe(
                    'Timezone for the schedule (e.g. UTC, America/New_York). Only used when creating a new config.',
                ),
            enabled: z
                .boolean()
                .optional()
                .default(true)
                .describe(
                    'Whether scheduled scaling is enabled on a newly created config (default true). Only used when creating a new config; use update_scheduled_scaling to toggle an existing one.',
                ),
            minDesired: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Override minimum desired count during this period'),
            maxDesired: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Override maximum desired count during this period'),
            desiredCount: z.number().int().min(0).optional().describe('Override desired count during this period'),
            scaleUpThreshold: z.number().optional().describe('Override scale up threshold during this period'),
            scaleDownThreshold: z.number().optional().describe('Override scale down threshold during this period'),
            scaleUpQuantity: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Override scale up quantity during this period'),
            scaleDownQuantity: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Override scale down quantity during this period'),
            reservationScaleUpThreshold: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                    'selenium-grid only: override the waiting-reserved-nodes threshold for scale-up during this period',
                ),
        },
        NON_IDEMPOTENT_WRITE,
        async (params) => {
            try {
                let config = await client.getScheduledScaling(params.name);
                const created = !config;

                if (!config) {
                    config = {
                        enabled: params.enabled,
                        timezone: params.timezone || 'UTC',
                        periods: [],
                    };
                }

                // Check for duplicate period name
                if (config.periods.some((p) => p.name === params.period_name)) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Period '${params.period_name}' already exists on '${params.name}'. Use update_scheduled_scaling to modify it.`,
                            },
                        ],
                        isError: true,
                    };
                }

                const scalingOptions: Record<string, number> = {};
                if (params.minDesired !== undefined) scalingOptions.minDesired = params.minDesired;
                if (params.maxDesired !== undefined) scalingOptions.maxDesired = params.maxDesired;
                if (params.desiredCount !== undefined) scalingOptions.desiredCount = params.desiredCount;
                if (params.scaleUpThreshold !== undefined) scalingOptions.scaleUpThreshold = params.scaleUpThreshold;
                if (params.scaleDownThreshold !== undefined)
                    scalingOptions.scaleDownThreshold = params.scaleDownThreshold;
                if (params.scaleUpQuantity !== undefined) scalingOptions.scaleUpQuantity = params.scaleUpQuantity;
                if (params.scaleDownQuantity !== undefined) scalingOptions.scaleDownQuantity = params.scaleDownQuantity;
                if (params.reservationScaleUpThreshold !== undefined)
                    scalingOptions.reservationScaleUpThreshold = params.reservationScaleUpThreshold;

                config.periods.push({
                    name: params.period_name,
                    dayOfWeek: params.dayOfWeek,
                    startHour: params.startHour,
                    startMinute: params.startMinute,
                    endHour: params.endHour,
                    endMinute: params.endMinute,
                    priority: params.priority ?? 1,
                    scalingOptions,
                    ...(params.inhibitScaleDown !== undefined && { inhibitScaleDown: params.inhibitScaleDown }),
                });

                await client.updateScheduledScaling(params.name, config);

                const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const days = params.dayOfWeek.map((d) => dayNames[d]).join(', ');
                const startMin = params.startMinute ?? 0;
                const endMin = params.endMinute ?? 0;
                const optParts: string[] = [];
                for (const [key, value] of Object.entries(scalingOptions)) {
                    optParts.push(`${key}=${value}`);
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: [
                                `Added period '${params.period_name}' to '${params.name}':`,
                                `  Days: ${days}`,
                                `  Time: ${params.startHour}:${String(startMin).padStart(2, '0')} - ${
                                    params.endHour
                                }:${String(endMin).padStart(2, '0')}`,
                                `  Priority: ${params.priority ?? 1}`,
                                optParts.length > 0 ? `  Scaling overrides: ${optParts.join(', ')}` : '',
                                created
                                    ? `  Created new scheduled scaling config (enabled=${config.enabled}, timezone=${config.timezone})`
                                    : '',
                            ]
                                .filter(Boolean)
                                .join('\n'),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error adding scheduled scaling period: ${(error as Error).message}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
