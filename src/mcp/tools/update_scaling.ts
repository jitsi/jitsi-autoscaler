import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerUpdateScalingOptions(server: McpServer, client: AutoscalerApiClient): void {
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'update_scaling_options',
        'Update scaling thresholds and quantities for an instance group without changing other group settings.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group'),
            scaleUpQuantity: z.number().optional().describe('Instances to add when scaling up'),
            scaleDownQuantity: z.number().optional().describe('Instances to remove when scaling down'),
            scaleUpThreshold: z.number().optional().describe('Stress threshold to trigger scale up'),
            scaleDownThreshold: z.number().optional().describe('Stress threshold to trigger scale down'),
            scalePeriod: z.number().optional().describe('Measurement period in seconds'),
            scaleUpPeriodsCount: z.number().optional().describe('Consecutive periods above threshold to scale up'),
            scaleDownPeriodsCount: z.number().optional().describe('Consecutive periods below threshold to scale down'),
        },
        async ({ base_url, auth_token, name, ...options }) => {
            try {
                await client.withOverrides(base_url, auth_token).updateScalingOptions(name, options);
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
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'update_desired_count',
        'Update the min, max, and/or desired instance count for a group.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group'),
            minDesired: z.number().optional().describe('Minimum desired instance count'),
            maxDesired: z.number().optional().describe('Maximum desired instance count'),
            desiredCount: z.number().optional().describe('Current desired instance count'),
        },
        async ({ base_url, auth_token, name, ...values }) => {
            try {
                await client.withOverrides(base_url, auth_token).updateDesiredCount(name, values);
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
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'update_scaling_activities',
        'Toggle scaling features (autoscale, launch, scheduler, etc.) for an instance group.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group'),
            enableAutoScale: z.boolean().optional().describe('Enable or disable autoscaling'),
            enableLaunch: z.boolean().optional().describe('Enable or disable instance launching'),
            enableScheduler: z.boolean().optional().describe('Enable or disable the scheduler'),
            enableUntrackedThrottle: z.boolean().optional().describe('Enable or disable untracked instance throttle'),
            enableReconfiguration: z.boolean().optional().describe('Enable or disable instance reconfiguration'),
        },
        async ({ base_url, auth_token, name, ...activities }) => {
            try {
                await client.withOverrides(base_url, auth_token).updateScalingActivities(name, activities);
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
