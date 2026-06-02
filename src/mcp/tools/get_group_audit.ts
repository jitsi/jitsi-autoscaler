import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerGetGroupAudit(server: McpServer, client: AutoscalerApiClient): void {
    // @ts-expect-error - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.tool(
        'get_group_audit',
        'Get recent scaling decisions and launch history for an instance group. Optionally includes per-instance audit details.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('The name of the instance group'),
            include_instance_audit: z
                .boolean()
                .optional()
                .default(false)
                .describe('Also include per-instance audit details'),
        },
        async ({ base_url, auth_token, name, include_instance_audit }) => {
            try {
                const c = client.withOverrides(base_url, auth_token);
                const audit = await c.getGroupAudit(name);
                if (!audit) {
                    return {
                        content: [{ type: 'text', text: `Group '${name}' not found.` }],
                        isError: true,
                    };
                }

                const lines: string[] = [
                    `# Audit: ${name}`,
                    '',
                    '## Last Activity',
                    `- **Last Autoscaler Run:** ${audit.lastAutoScalerRun || 'Never'}`,
                    `- **Last Launcher Run:** ${audit.lastLauncherRun || 'Never'}`,
                    `- **Last Reconfigure Request:** ${audit.lastReconfigureRequest || 'Never'}`,
                ];

                if (audit.lastScaleMetrics && audit.lastScaleMetrics.length > 0) {
                    lines.push(`- **Last Scale Metrics:** [${audit.lastScaleMetrics.join(', ')}]`);
                }

                if (audit.autoScalerActionItems && audit.autoScalerActionItems.length > 0) {
                    lines.push('', '## Autoscaler Actions', '');
                    const header = ['Timestamp', 'Action', 'Count', 'Old Desired', 'New Desired', 'Metrics'].join(
                        ' | ',
                    );
                    const separator = header
                        .split(' | ')
                        .map(() => '---')
                        .join(' | ');
                    lines.push(header, separator);

                    for (const item of audit.autoScalerActionItems) {
                        const ts =
                            typeof item.timestamp === 'number'
                                ? new Date(item.timestamp).toISOString()
                                : item.timestamp;
                        lines.push(
                            [
                                ts,
                                item.actionType,
                                item.count,
                                item.oldDesiredCount,
                                item.newDesiredCount,
                                `[${item.scaleMetrics.join(', ')}]`,
                            ].join(' | '),
                        );
                    }
                }

                if (audit.launcherActionItems && audit.launcherActionItems.length > 0) {
                    lines.push('', '## Launcher Actions', '');
                    const header = ['Timestamp', 'Action', 'Count', 'Desired', 'Scale Quantity'].join(' | ');
                    const separator = header
                        .split(' | ')
                        .map(() => '---')
                        .join(' | ');
                    lines.push(header, separator);

                    for (const item of audit.launcherActionItems) {
                        const ts =
                            typeof item.timestamp === 'number'
                                ? new Date(item.timestamp).toISOString()
                                : item.timestamp;
                        lines.push(
                            [ts, item.actionType, item.count, item.desiredCount, item.scaleQuantity].join(' | '),
                        );
                    }
                }

                if (include_instance_audit) {
                    const instanceAudit = await c.getInstanceAudit(name);
                    if (instanceAudit && instanceAudit.length > 0) {
                        lines.push('', '## Instance Audit', '');
                        for (const inst of instanceAudit) {
                            lines.push(`### ${inst.instanceId}`);
                            lines.push(`- **Launch Requested:** ${inst.requestToLaunch || '-'}`);
                            lines.push(`- **Latest Status:** ${inst.latestStatus || '-'}`);
                            lines.push(`- **Terminate Requested:** ${inst.requestToTerminate || '-'}`);
                            lines.push(`- **Reconfigure Requested:** ${inst.requestToReconfigure || '-'}`);
                            lines.push(`- **Reconfigure Complete:** ${inst.reconfigureComplete || '-'}`);
                            lines.push(`- **Termination Confirmed:** ${inst.terminationConfirmation || '-'}`);
                            lines.push('');
                        }
                    }
                }

                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error getting group audit: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
