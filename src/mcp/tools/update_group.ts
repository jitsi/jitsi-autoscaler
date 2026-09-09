import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';
import { InstanceGroup } from '../../instance_store';
import { IDEMPOTENT_WRITE } from './annotations';

/** The tool's input, mirroring the zod schema below. */
interface UpdateGroupParams {
    name: string;
    type?: string;
    region?: string;
    environment?: string;
    cloud?: string;
    compartmentId?: string;
    instanceConfigurationId?: string;
    enableAutoScale?: boolean;
    enableLaunch?: boolean;
    enableScheduler?: boolean;
    enableUntrackedThrottle?: boolean;
    enableReconfiguration?: boolean;
    gracePeriodTTLSec?: number;
    protectedTTLSec?: number;
    minDesired?: number;
    maxDesired?: number;
    desiredCount?: number;
    scaleUpQuantity?: number;
    scaleDownQuantity?: number;
    scaleUpThreshold?: number;
    scaleDownThreshold?: number;
    scalePeriod?: number;
    scaleUpPeriodsCount?: number;
    scaleDownPeriodsCount?: number;
    reservationScaleUpThreshold?: number;
    seleniumGridUrl?: string;
    tags?: Record<string, string>;
}

type DesiredField = 'minDesired' | 'maxDesired' | 'desiredCount';
type ScalingOptionField =
    | 'scaleUpQuantity'
    | 'scaleDownQuantity'
    | 'scaleUpThreshold'
    | 'scaleDownThreshold'
    | 'scalePeriod'
    | 'scaleUpPeriodsCount'
    | 'scaleDownPeriodsCount'
    | 'reservationScaleUpThreshold';
type ActivityField =
    | 'enableAutoScale'
    | 'enableLaunch'
    | 'enableScheduler'
    | 'enableUntrackedThrottle'
    | 'enableReconfiguration';
type StructuralField =
    | 'type'
    | 'region'
    | 'environment'
    | 'cloud'
    | 'compartmentId'
    | 'instanceConfigurationId'
    | 'gracePeriodTTLSec'
    | 'protectedTTLSec'
    | 'seleniumGridUrl'
    | 'tags';

const DESIRED_FIELDS: DesiredField[] = ['minDesired', 'maxDesired', 'desiredCount'];
const SCALING_OPTION_FIELDS: ScalingOptionField[] = [
    'scaleUpQuantity',
    'scaleDownQuantity',
    'scaleUpThreshold',
    'scaleDownThreshold',
    'scalePeriod',
    'scaleUpPeriodsCount',
    'scaleDownPeriodsCount',
    'reservationScaleUpThreshold',
];
const ACTIVITY_FIELDS: ActivityField[] = [
    'enableAutoScale',
    'enableLaunch',
    'enableScheduler',
    'enableUntrackedThrottle',
    'enableReconfiguration',
];
const STRUCTURAL_FIELDS: StructuralField[] = [
    'type',
    'region',
    'environment',
    'cloud',
    'compartmentId',
    'instanceConfigurationId',
    'gracePeriodTTLSec',
    'protectedTTLSec',
    'seleniumGridUrl',
    'tags',
];

/** Returns the subset of `keys` that are present (not undefined) in `params`, preserving their types. */
function pick<T extends object, K extends keyof T>(params: T, keys: readonly K[]): Partial<Pick<T, K>> {
    const out: Partial<Pick<T, K>> = {};
    for (const key of keys) {
        if (params[key] !== undefined) out[key] = params[key];
    }
    return out;
}

export function registerUpdateGroup(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'update_group',
        [
            'Update an existing instance group. Only the specified fields are changed.',
            'Scaling counts, thresholds/quantities/periods, and enable* flags are sent through their dedicated',
            'field-wise endpoints so no unrelated live state is written back.',
            'Changing structural fields (type, region, environment, cloud, compartmentId, instanceConfigurationId,',
            'gracePeriodTTLSec, protectedTTLSec, seleniumGridUrl, tags) requires a full group PUT: the group is',
            're-read immediately before the write and all requested changes are merged into that snapshot, but a',
            'concurrent autoscaler decision in that brief window could still be overwritten.',
        ].join(' '),
        {
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
            gracePeriodTTLSec: z.number().int().min(0).optional().describe('Grace period TTL in seconds'),
            protectedTTLSec: z.number().int().min(0).optional().describe('Protected TTL in seconds'),
            minDesired: z.number().int().min(0).optional().describe('Minimum desired instance count'),
            maxDesired: z.number().int().min(0).optional().describe('Maximum desired instance count'),
            desiredCount: z.number().int().min(0).optional().describe('Current desired instance count'),
            scaleUpQuantity: z.number().int().min(0).optional().describe('Instances to add when scaling up'),
            scaleDownQuantity: z.number().int().min(0).optional().describe('Instances to remove when scaling down'),
            scaleUpThreshold: z.number().optional().describe('Scale up threshold'),
            scaleDownThreshold: z.number().optional().describe('Scale down threshold'),
            scalePeriod: z.number().int().min(1).optional().describe('Measurement period in seconds'),
            scaleUpPeriodsCount: z.number().int().min(1).optional().describe('Periods above threshold to scale up'),
            scaleDownPeriodsCount: z.number().int().min(1).optional().describe('Periods below threshold to scale down'),
            reservationScaleUpThreshold: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('selenium-grid only: waiting reserved nodes before reservations raise the desired count'),
            seleniumGridUrl: z
                .string()
                .optional()
                .describe('selenium-grid only: URL of the Selenium Grid /status endpoint'),
            tags: z.record(z.string()).optional().describe('Tags (replaces all tags)'),
        },
        IDEMPOTENT_WRITE,
        async (rawParams) => {
            try {
                const params = rawParams as UpdateGroupParams;
                const desired = pick(params, DESIRED_FIELDS);
                const scalingOptions = pick(params, SCALING_OPTION_FIELDS);
                const activities = pick(params, ACTIVITY_FIELDS);
                const structural = pick(params, STRUCTURAL_FIELDS);

                const changedKeys = [
                    ...Object.keys(desired),
                    ...Object.keys(scalingOptions),
                    ...Object.keys(activities),
                    ...Object.keys(structural),
                ];

                // Existence check (and, on the full-PUT path, the snapshot we merge into).
                const existing = await client.getGroup(params.name);
                if (!existing) {
                    return {
                        content: [{ type: 'text', text: `Group '${params.name}' not found.` }],
                        isError: true,
                    };
                }

                if (changedKeys.length === 0) {
                    return {
                        content: [{ type: 'text', text: `No changes specified for group '${params.name}'.` }],
                    };
                }

                if (Object.keys(structural).length > 0) {
                    // Full PUT is unavoidable: the server requires the complete group (including
                    // scalingOptions.desiredCount), so merge everything into the fresh snapshot.
                    const merged: InstanceGroup = {
                        ...existing,
                        ...structural,
                        ...activities,
                        scalingOptions: { ...existing.scalingOptions, ...desired, ...scalingOptions },
                    };
                    await client.upsertGroup(params.name, merged);
                } else {
                    if (Object.keys(desired).length > 0) {
                        await client.updateDesiredCount(params.name, desired);
                    }
                    if (Object.keys(scalingOptions).length > 0) {
                        await client.updateScalingOptions(params.name, scalingOptions);
                    }
                    if (Object.keys(activities).length > 0) {
                        await client.updateScalingActivities(params.name, activities);
                    }
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Group '${params.name}' updated successfully (${changedKeys.join(', ')}).`,
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
