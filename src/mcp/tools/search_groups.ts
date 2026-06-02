import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerSearchGroups(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size; tsc with 8GB is fine
    server.tool(
        'search_groups',
        'Search and list autoscaler instance groups with optional filters. Returns a summary table of matching groups.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name_pattern: z.string().optional().describe('Regex pattern to filter group names'),
            type: z
                .string()
                .optional()
                .describe('Instance type filter (e.g. jibri, jigasi, JVB, sip-jibri, nomad, whisper)'),
            region: z.string().optional().describe('Region filter'),
            environment: z.string().optional().describe('Environment filter'),
            cloud: z.string().optional().describe('Cloud provider filter (e.g. oracle, digitalocean, nomad, custom)'),
            tags: z.record(z.string()).optional().describe('Tag key-value pairs to filter by (all must match)'),
        },
        async ({ base_url, auth_token, name_pattern, type, region, environment, cloud, tags }) => {
            try {
                const c = client.withOverrides(base_url, auth_token);
                let groups = await c.listGroups(tags);

                if (name_pattern) {
                    let re: RegExp;
                    try {
                        re = new RegExp(name_pattern, 'i');
                    } catch {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `Invalid regex pattern: '${name_pattern}'`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    groups = groups.filter((g) => re.test(g.name));
                }
                if (type) {
                    const lowerType = type.toLowerCase();
                    groups = groups.filter((g) => g.type.toLowerCase() === lowerType);
                }
                if (region) {
                    const lowerRegion = region.toLowerCase();
                    groups = groups.filter((g) => g.region.toLowerCase() === lowerRegion);
                }
                if (environment) {
                    const lowerEnv = environment.toLowerCase();
                    groups = groups.filter((g) => g.environment.toLowerCase() === lowerEnv);
                }
                if (cloud) {
                    const lowerCloud = cloud.toLowerCase();
                    groups = groups.filter((g) => g.cloud.toLowerCase() === lowerCloud);
                }

                if (groups.length === 0) {
                    return { content: [{ type: 'text', text: 'No groups found matching the specified filters.' }] };
                }

                const header = [
                    'Name',
                    'Type',
                    'Region',
                    'Environment',
                    'Cloud',
                    'Desired',
                    'Min',
                    'Max',
                    'AutoScale',
                    'Launch',
                ].join(' | ');
                const separator = header
                    .split(' | ')
                    .map(() => '---')
                    .join(' | ');
                const rows = groups.map((g) =>
                    [
                        g.name,
                        g.type,
                        g.region,
                        g.environment,
                        g.cloud,
                        g.scalingOptions.desiredCount,
                        g.scalingOptions.minDesired,
                        g.scalingOptions.maxDesired,
                        g.enableAutoScale ? 'Yes' : 'No',
                        g.enableLaunch ? 'Yes' : 'No',
                    ].join(' | '),
                );

                const table = [`Found ${groups.length} group(s):`, '', header, separator, ...rows].join('\n');

                return { content: [{ type: 'text', text: table }] };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error searching groups: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
