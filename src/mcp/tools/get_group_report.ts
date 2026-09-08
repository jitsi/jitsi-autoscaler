import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';
import { READ_ONLY } from './annotations';

export function registerGetGroupReport(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'get_group_report',
        'Get a live status report for an instance group, including instance counts by status and per-instance details.',
        {
            name: z.string().describe('The name of the instance group'),
        },
        READ_ONLY,
        async ({ name }) => {
            try {
                const report = await client.getGroupReport(name);
                if (!report) {
                    return {
                        content: [{ type: 'text', text: `Group '${name}' not found.` }],
                        isError: true,
                    };
                }

                const lines: string[] = [
                    `# Report: ${report.groupName}`,
                    '',
                    '## Instance Counts',
                    `- **Total Tracked:** ${report.count ?? 0}`,
                    `- **Desired:** ${report.desiredCount ?? 0}`,
                    `- **Provisioning:** ${report.provisioningCount ?? 0}`,
                    `- **Available (idle):** ${report.availableCount ?? 0}`,
                    `- **Busy:** ${report.busyCount ?? 0}`,
                    `- **Expired:** ${report.expiredCount ?? 0}`,
                    `- **Cloud Count:** ${report.cloudCount ?? 0}`,
                    `- **Untracked:** ${report.unTrackedCount ?? 0}`,
                    `- **Shutting Down:** ${report.shuttingDownCount ?? 0}`,
                    `- **Shutdown Complete:** ${report.shutdownCount ?? 0}`,
                    `- **Shutdown Errors:** ${report.shutdownErrorCount ?? 0}`,
                    `- **Reconfigure Errors:** ${report.reconfigureErrorCount ?? 0}`,
                    `- **Reconfigure Scheduled:** ${report.reconfigureScheduledCount ?? 0}`,
                    `- **Scale Down Protected:** ${report.scaleDownProtectedCount ?? 0}`,
                ];

                if (report.instances && report.instances.length > 0) {
                    lines.push('', '## Instances', '');
                    const header = [
                        'Instance ID',
                        'Name',
                        'Scale Status',
                        'Cloud Status',
                        'Shutting Down',
                        'Protected',
                        'IP',
                        'Version',
                    ].join(' | ');
                    const separator = header
                        .split(' | ')
                        .map(() => '---')
                        .join(' | ');
                    lines.push(header, separator);

                    for (const inst of report.instances) {
                        lines.push(
                            [
                                inst.instanceId,
                                inst.displayName || inst.instanceName || '-',
                                inst.scaleStatus || '-',
                                inst.cloudStatus || '-',
                                inst.isShuttingDown ? 'Yes' : 'No',
                                inst.isScaleDownProtected ? 'Yes' : 'No',
                                inst.privateIp || inst.publicIp || '-',
                                inst.version || '-',
                            ].join(' | '),
                        );
                    }
                }

                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error getting group report: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
