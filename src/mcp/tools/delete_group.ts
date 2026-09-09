import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient } from '../api_client';
import { DESTRUCTIVE } from './annotations';

export function registerDeleteGroup(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'delete_group',
        'Delete an instance group. The group must have no active instances before it can be deleted.',
        {
            name: z.string().describe('Name of the instance group to delete'),
        },
        DESTRUCTIVE,
        async ({ name }) => {
            try {
                await client.deleteGroup(name);
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
