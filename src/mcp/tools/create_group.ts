import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';
import { InstanceGroup } from '../../instance_store';

export function registerCreateGroup(server: McpServer, client: AutoscalerApiClient): void {
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'create_group',
        'Create a new autoscaler instance group with the specified configuration.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Unique name for the instance group'),
            type: z.string().describe('Instance type (e.g. jibri, sip-jibri, jigasi, JVB, nomad, whisper)'),
            region: z.string().describe('Region for the group'),
            environment: z.string().describe('Environment name'),
            cloud: z.string().describe('Cloud provider (e.g. oracle, digitalocean, nomad, custom)'),
            compartmentId: z.string().describe('Cloud compartment/project ID'),
            instanceConfigurationId: z.string().describe('Instance configuration/template ID'),
            enableAutoScale: z.boolean().optional().default(true).describe('Enable autoscaling'),
            enableLaunch: z.boolean().optional().default(true).describe('Enable instance launching'),
            enableScheduler: z.boolean().optional().default(true).describe('Enable the scheduler'),
            enableUntrackedThrottle: z.boolean().optional().default(false).describe('Enable untracked throttle'),
            enableReconfiguration: z.boolean().optional().default(false).describe('Enable reconfiguration'),
            gracePeriodTTLSec: z.number().optional().default(480).describe('Grace period TTL in seconds'),
            protectedTTLSec: z.number().optional().default(600).describe('Protected TTL in seconds'),
            minDesired: z.number().describe('Minimum desired instance count'),
            maxDesired: z.number().describe('Maximum desired instance count'),
            desiredCount: z.number().describe('Current desired instance count'),
            scaleUpQuantity: z.number().optional().default(1).describe('Number of instances to add when scaling up'),
            scaleDownQuantity: z
                .number()
                .optional()
                .default(1)
                .describe('Number of instances to remove when scaling down'),
            scaleUpThreshold: z
                .number()
                .describe('Stress threshold to trigger scale up (0-1 for stress, count for availability)'),
            scaleDownThreshold: z
                .number()
                .describe('Stress threshold to trigger scale down (0-1 for stress, count for availability)'),
            scalePeriod: z.number().optional().default(60).describe('Measurement period in seconds'),
            scaleUpPeriodsCount: z
                .number()
                .optional()
                .default(2)
                .describe('Consecutive periods above threshold to trigger scale up'),
            scaleDownPeriodsCount: z
                .number()
                .optional()
                .default(4)
                .describe('Consecutive periods below threshold to trigger scale down'),
            tags: z.record(z.string()).optional().default({}).describe('Key-value tags for the group'),
        },
        async (params) => {
            try {
                if (params.desiredCount < params.minDesired || params.desiredCount > params.maxDesired) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Validation error: desiredCount (${params.desiredCount}) must be between minDesired (${params.minDesired}) and maxDesired (${params.maxDesired}).`,
                            },
                        ],
                        isError: true,
                    };
                }

                const group: InstanceGroup = {
                    id: params.name,
                    name: params.name,
                    type: params.type,
                    region: params.region,
                    environment: params.environment,
                    cloud: params.cloud,
                    compartmentId: params.compartmentId,
                    instanceConfigurationId: params.instanceConfigurationId,
                    enableAutoScale: params.enableAutoScale,
                    enableLaunch: params.enableLaunch,
                    enableScheduler: params.enableScheduler,
                    enableUntrackedThrottle: params.enableUntrackedThrottle,
                    enableReconfiguration: params.enableReconfiguration,
                    gracePeriodTTLSec: params.gracePeriodTTLSec,
                    protectedTTLSec: params.protectedTTLSec,
                    scalingOptions: {
                        minDesired: params.minDesired,
                        maxDesired: params.maxDesired,
                        desiredCount: params.desiredCount,
                        scaleUpQuantity: params.scaleUpQuantity,
                        scaleDownQuantity: params.scaleDownQuantity,
                        scaleUpThreshold: params.scaleUpThreshold,
                        scaleDownThreshold: params.scaleDownThreshold,
                        scalePeriod: params.scalePeriod,
                        scaleUpPeriodsCount: params.scaleUpPeriodsCount,
                        scaleDownPeriodsCount: params.scaleDownPeriodsCount,
                    },
                    tags: params.tags,
                };

                await client.withOverrides(params.base_url, params.auth_token).upsertGroup(params.name, group);

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Group '${params.name}' created successfully.\n\nType: ${params.type}, Region: ${params.region}, Environment: ${params.environment}\nDesired: ${params.desiredCount} (min: ${params.minDesired}, max: ${params.maxDesired})`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error creating group: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
