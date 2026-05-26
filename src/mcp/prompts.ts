import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.prompt(
        'diagnose_scaling_issues',
        'Diagnose why an instance group is not scaling as expected',
        { group_name: z.string().describe('The name of the instance group to diagnose') },
        ({ group_name }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: [
                            `Please diagnose scaling issues for the autoscaler group "${group_name}". Follow these steps:`,
                            '',
                            '1. Use the `describe_group` tool to get the full group configuration.',
                            '2. Use the `get_group_report` tool to see the current instance counts and statuses.',
                            '3. Use the `get_group_audit` tool (with include_instance_audit=true) to see recent scaling decisions.',
                            '',
                            'Then analyze:',
                            '- Is `enableAutoScale` enabled? Is `enableLaunch` enabled?',
                            '- Are the scale up/down thresholds reasonable for the group type?',
                            '- Is the desired count within the min/max range?',
                            '- Are there recent autoscaler actions? If not, why might scaling not be triggering?',
                            '- Are there instances stuck in provisioning or shutdown error states?',
                            '- Is there a mismatch between tracked instances and cloud instances (untracked count)?',
                            '- If scheduled scaling is configured, is the active period correct?',
                            '',
                            'Provide a clear summary of what you found and any recommended changes.',
                        ].join('\n'),
                    },
                },
            ],
        }),
    );

    // @ts-ignore - MCP SDK zod type inference may exceed TypeScript recursion limit
    server.prompt('capacity_overview', 'Get an overview of all autoscaler groups and their capacity', {}, () => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: [
                        'Please provide a capacity overview of all autoscaler groups. Follow these steps:',
                        '',
                        '1. Use the `search_groups` tool with no filters to list all groups.',
                        '2. Summarize by type, region, and environment:',
                        '   - Total desired, min, and max counts',
                        '   - How many groups have autoscaling enabled vs disabled',
                        '   - How many groups have launching enabled vs disabled',
                        '',
                        '3. Highlight any groups that look misconfigured:',
                        '   - Autoscaling disabled but desired count > 0',
                        '   - Desired count at min or max (may need adjustment)',
                        '   - Launch disabled (instances cannot be created/destroyed)',
                        '',
                        'Present the results in a clear, organized format grouped by environment and region.',
                    ].join('\n'),
                },
            },
        ],
    }));
}
