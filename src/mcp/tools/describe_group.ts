import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerDescribeGroup(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'describe_group',
        'Get detailed configuration of a specific autoscaler instance group, including scaling options, feature flags, tags, and scheduled scaling.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('The name of the instance group'),
        },
        async ({ base_url, auth_token, name }) => {
            try {
                const c = client.withOverrides(base_url, auth_token);
                const group = await c.getGroup(name);
                if (!group) {
                    return {
                        content: [{ type: 'text', text: `Group '${name}' not found.` }],
                        isError: true,
                    };
                }

                const scheduledScaling = await c.getScheduledScaling(name).catch((): null => null);

                const lines: string[] = [
                    `# Group: ${group.name}`,
                    '',
                    '## General',
                    `- **ID:** ${group.id}`,
                    `- **Type:** ${group.type}`,
                    `- **Region:** ${group.region}`,
                    `- **Environment:** ${group.environment}`,
                    `- **Cloud:** ${group.cloud}`,
                    `- **Compartment ID:** ${group.compartmentId}`,
                    `- **Instance Configuration ID:** ${group.instanceConfigurationId}`,
                    '',
                    '## Feature Flags',
                    `- **AutoScale:** ${group.enableAutoScale ? 'Enabled' : 'Disabled'}`,
                    `- **Launch:** ${group.enableLaunch ? 'Enabled' : 'Disabled'}`,
                    `- **Scheduler:** ${group.enableScheduler ? 'Enabled' : 'Disabled'}`,
                    `- **Untracked Throttle:** ${group.enableUntrackedThrottle ? 'Enabled' : 'Disabled'}`,
                    `- **Reconfiguration:** ${group.enableReconfiguration ? 'Enabled' : 'Disabled'}`,
                    `- **Cloud Guard:** ${group.enableCloudGuard ? 'Enabled' : 'Disabled'}`,
                    '',
                    '## Scaling Options',
                    `- **Desired Count:** ${group.scalingOptions.desiredCount}`,
                    `- **Min Desired:** ${group.scalingOptions.minDesired}`,
                    `- **Max Desired:** ${group.scalingOptions.maxDesired}`,
                    `- **Scale Up Threshold:** ${group.scalingOptions.scaleUpThreshold}`,
                    `- **Scale Down Threshold:** ${group.scalingOptions.scaleDownThreshold}`,
                    `- **Scale Up Quantity:** ${group.scalingOptions.scaleUpQuantity}`,
                    `- **Scale Down Quantity:** ${group.scalingOptions.scaleDownQuantity}`,
                    `- **Scale Period:** ${group.scalingOptions.scalePeriod}s`,
                    `- **Scale Up Periods Count:** ${group.scalingOptions.scaleUpPeriodsCount}`,
                    `- **Scale Down Periods Count:** ${group.scalingOptions.scaleDownPeriodsCount}`,
                ];

                if (group.scalingOptions.cloudGuardGraceCount !== undefined) {
                    lines.push(`- **Cloud Guard Grace Count:** ${group.scalingOptions.cloudGuardGraceCount}`);
                }
                if (group.scalingOptions.reservationScaleUpThreshold !== undefined) {
                    lines.push(
                        `- **Reservation Scale-Up Threshold:** ${group.scalingOptions.reservationScaleUpThreshold}`,
                    );
                }

                if (group.type === 'selenium-grid' || group.seleniumGridUrl) {
                    lines.push(
                        '',
                        '## Selenium Grid',
                        `- **Grid Status URL:** ${group.seleniumGridUrl || '(not set)'}`,
                    );
                }

                lines.push('', '## TTLs', `- **Grace Period TTL:** ${group.gracePeriodTTLSec}s`);
                lines.push(`- **Protected TTL:** ${group.protectedTTLSec}s`);

                if (group.tags && Object.keys(group.tags).length > 0) {
                    lines.push('', '## Tags');
                    for (const [key, value] of Object.entries(group.tags)) {
                        lines.push(`- **${key}:** ${value}`);
                    }
                }

                if (scheduledScaling && scheduledScaling.periods?.length > 0) {
                    lines.push(
                        '',
                        '## Scheduled Scaling',
                        `- **Enabled:** ${scheduledScaling.enabled}`,
                        `- **Timezone:** ${scheduledScaling.timezone || 'UTC'}`,
                        '',
                    );
                    for (const period of scheduledScaling.periods) {
                        lines.push(`### Period: ${period.name}`);
                        lines.push(`- **Days:** ${period.dayOfWeek.join(', ')}`);
                        lines.push(
                            `- **Time:** ${period.startHour}:${String(period.startMinute || 0).padStart(2, '0')} - ${
                                period.endHour
                            }:${String(period.endMinute || 0).padStart(2, '0')}`,
                        );
                        lines.push(`- **Priority:** ${period.priority}`);
                        if (period.inhibitScaleDown) {
                            lines.push('- **Inhibit Scale Down:** Yes');
                        }
                        if (period.scalingOptions) {
                            const opts = period.scalingOptions;
                            const optParts: string[] = [];
                            if (opts.minDesired !== undefined) optParts.push(`min=${opts.minDesired}`);
                            if (opts.maxDesired !== undefined) optParts.push(`max=${opts.maxDesired}`);
                            if (opts.desiredCount !== undefined) optParts.push(`desired=${opts.desiredCount}`);
                            if (opts.scaleUpThreshold !== undefined)
                                optParts.push(`upThreshold=${opts.scaleUpThreshold}`);
                            if (opts.scaleDownThreshold !== undefined)
                                optParts.push(`downThreshold=${opts.scaleDownThreshold}`);
                            if (opts.reservationScaleUpThreshold !== undefined)
                                optParts.push(`reservationScaleUpThreshold=${opts.reservationScaleUpThreshold}`);
                            if (optParts.length > 0) {
                                lines.push(`- **Scaling Overrides:** ${optParts.join(', ')}`);
                            }
                        }
                        lines.push('');
                    }
                }

                if (group.scheduledScalingActivePeriod) {
                    lines.push(`**Active Scheduled Period:** ${group.scheduledScalingActivePeriod}`);
                }

                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error describing group: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
