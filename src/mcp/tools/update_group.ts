import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerUpdateGroup(server: McpServer, client: AutoscalerApiClient): void {
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'update_group',
        'Update an existing instance group. Fetches the current group, merges the provided fields, and saves the result. Only specified fields are changed.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group to update'),
            type: z.string().optional().describe('Instance type'),
            region: z.string().optional().describe('Region'),
            environment: z.string().optional().describe('Environment'),
            cloud: z.string().optional().describe('Cloud provider'),
            compartmentId: z.string().optional().describe('Cloud compartment/project ID'),
            instanceConfigurationId: z.string().optional().describe('Instance configuration/template ID'),
            enableAutoScale: z.boolean().optional().describe('Enable autoscaling'),
            enableLaunch: z.boolean().optional().describe('Enable instance launching'),
            enableScheduler: z.boolean().optional().describe('Enable the scheduler'),
            enableUntrackedThrottle: z.boolean().optional().describe('Enable untracked throttle'),
            enableReconfiguration: z.boolean().optional().describe('Enable reconfiguration'),
            gracePeriodTTLSec: z.number().optional().describe('Grace period TTL in seconds'),
            protectedTTLSec: z.number().optional().describe('Protected TTL in seconds'),
            minDesired: z.number().optional().describe('Minimum desired instance count'),
            maxDesired: z.number().optional().describe('Maximum desired instance count'),
            desiredCount: z.number().optional().describe('Current desired instance count'),
            scaleUpQuantity: z.number().optional().describe('Instances to add when scaling up'),
            scaleDownQuantity: z.number().optional().describe('Instances to remove when scaling down'),
            scaleUpThreshold: z.number().optional().describe('Scale up threshold'),
            scaleDownThreshold: z.number().optional().describe('Scale down threshold'),
            scalePeriod: z.number().optional().describe('Measurement period in seconds'),
            scaleUpPeriodsCount: z.number().optional().describe('Periods above threshold to scale up'),
            scaleDownPeriodsCount: z.number().optional().describe('Periods below threshold to scale down'),
            tags: z.record(z.string()).optional().describe('Tags (replaces all tags)'),
        },
        async (params) => {
            try {
                const c = client.withOverrides(params.base_url, params.auth_token);
                const existing = await c.getGroup(params.name);
                if (!existing) {
                    return {
                        content: [{ type: 'text', text: `Group '${params.name}' not found.` }],
                        isError: true,
                    };
                }

                // Merge top-level fields
                const merged = { ...existing };
                if (params.type !== undefined) merged.type = params.type;
                if (params.region !== undefined) merged.region = params.region;
                if (params.environment !== undefined) merged.environment = params.environment;
                if (params.cloud !== undefined) merged.cloud = params.cloud;
                if (params.compartmentId !== undefined) merged.compartmentId = params.compartmentId;
                if (params.instanceConfigurationId !== undefined)
                    merged.instanceConfigurationId = params.instanceConfigurationId;
                if (params.enableAutoScale !== undefined) merged.enableAutoScale = params.enableAutoScale;
                if (params.enableLaunch !== undefined) merged.enableLaunch = params.enableLaunch;
                if (params.enableScheduler !== undefined) merged.enableScheduler = params.enableScheduler;
                if (params.enableUntrackedThrottle !== undefined)
                    merged.enableUntrackedThrottle = params.enableUntrackedThrottle;
                if (params.enableReconfiguration !== undefined)
                    merged.enableReconfiguration = params.enableReconfiguration;
                if (params.gracePeriodTTLSec !== undefined) merged.gracePeriodTTLSec = params.gracePeriodTTLSec;
                if (params.protectedTTLSec !== undefined) merged.protectedTTLSec = params.protectedTTLSec;
                if (params.tags !== undefined) merged.tags = params.tags;

                // Merge scaling options
                const so = { ...merged.scalingOptions };
                if (params.minDesired !== undefined) so.minDesired = params.minDesired;
                if (params.maxDesired !== undefined) so.maxDesired = params.maxDesired;
                if (params.desiredCount !== undefined) so.desiredCount = params.desiredCount;
                if (params.scaleUpQuantity !== undefined) so.scaleUpQuantity = params.scaleUpQuantity;
                if (params.scaleDownQuantity !== undefined) so.scaleDownQuantity = params.scaleDownQuantity;
                if (params.scaleUpThreshold !== undefined) so.scaleUpThreshold = params.scaleUpThreshold;
                if (params.scaleDownThreshold !== undefined) so.scaleDownThreshold = params.scaleDownThreshold;
                if (params.scalePeriod !== undefined) so.scalePeriod = params.scalePeriod;
                if (params.scaleUpPeriodsCount !== undefined) so.scaleUpPeriodsCount = params.scaleUpPeriodsCount;
                if (params.scaleDownPeriodsCount !== undefined) so.scaleDownPeriodsCount = params.scaleDownPeriodsCount;
                merged.scalingOptions = so;

                await c.upsertGroup(params.name, merged);

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Group '${params.name}' updated successfully.`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error updating group: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
