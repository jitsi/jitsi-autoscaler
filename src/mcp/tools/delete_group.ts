import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';

export function registerDeleteGroup(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'delete_group',
        'Delete an instance group. The group must have no active instances before it can be deleted.',
        {
            base_url: z.string().optional().describe('Override the default autoscaler base URL for this request'),
            auth_token: z.string().optional().describe('Override the default auth token for this request'),
            name: z.string().describe('Name of the instance group to delete'),
        },
        async ({ base_url, auth_token, name }) => {
            try {
                await client.withOverrides(base_url, auth_token).deleteGroup(name);
                return {
                    content: [{ type: 'text', text: `Group '${name}' deleted successfully.` }],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error deleting group: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
