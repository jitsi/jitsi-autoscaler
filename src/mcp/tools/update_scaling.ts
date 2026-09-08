import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';
import { IDEMPOTENT_WRITE } from './annotations';

export function registerUpdateScalingOptions(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'update_scaling_options',
        'Update scaling thresholds and quantities for an instance group without changing other group settings.',
        {
            name: z.string().describe('Name of the instance group'),
            scaleUpQuantity: z.number().int().min(0).optional().describe('Instances to add when scaling up'),
            scaleDownQuantity: z.number().int().min(0).optional().describe('Instances to remove when scaling down'),
            scaleUpThreshold: z.number().optional().describe('Stress threshold to trigger scale up'),
            scaleDownThreshold: z.number().optional().describe('Stress threshold to trigger scale down'),
            scalePeriod: z.number().int().min(1).optional().describe('Measurement period in seconds'),
            scaleUpPeriodsCount: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('Consecutive periods above threshold to scale up'),
            scaleDownPeriodsCount: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('Consecutive periods below threshold to scale down'),
            reservationScaleUpThreshold: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                    'selenium-grid only: minimum number of waiting reserved nodes before reservations raise the desired count',
                ),
        },
        IDEMPOTENT_WRITE,
        async ({ name, ...options }) => {
            try {
                await client.updateScalingOptions(name, options);
                const changed = Object.entries(options)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Scaling options updated for '${name}': ${changed || 'no changes'}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error updating scaling options: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export function registerUpdateDesiredCount(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'update_desired_count',
        'Update the min, max, and/or desired instance count for a group.',
        {
            name: z.string().describe('Name of the instance group'),
            minDesired: z.number().int().min(0).optional().describe('Minimum desired instance count'),
            maxDesired: z.number().int().min(0).optional().describe('Maximum desired instance count'),
            desiredCount: z.number().int().min(0).optional().describe('Current desired instance count'),
        },
        IDEMPOTENT_WRITE,
        async ({ name, ...values }) => {
            try {
                await client.updateDesiredCount(name, values);
                const changed = Object.entries(values)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Desired count updated for '${name}': ${changed || 'no changes'}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error updating desired count: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export function registerUpdateScalingActivities(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'update_scaling_activities',
        'Toggle scaling features (autoscale, launch, scheduler, etc.) for an instance group.',
        {
            name: z.string().describe('Name of the instance group'),
            enableAutoScale: z.boolean().optional().describe('Enable or disable autoscaling'),
            enableLaunch: z.boolean().optional().describe('Enable or disable instance launching'),
            enableScheduler: z.boolean().optional().describe('Enable or disable the scheduler'),
            enableUntrackedThrottle: z.boolean().optional().describe('Enable or disable untracked instance throttle'),
            enableReconfiguration: z.boolean().optional().describe('Enable or disable instance reconfiguration'),
        },
        IDEMPOTENT_WRITE,
        async ({ name, ...activities }) => {
            try {
                await client.updateScalingActivities(name, activities);
                const changed = Object.entries(activities)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Scaling activities updated for '${name}': ${changed || 'no changes'}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error updating scaling activities: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
