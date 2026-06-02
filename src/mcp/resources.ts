import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AutoscalerApiClient } from './api_client';

export function registerResources(server: McpServer, client: AutoscalerApiClient): void {
    // Static resource: list of all group names
    server.resource('groups-list', 'autoscaler://groups', async () => {
        const groups = await client.listGroups();
        const names = groups.map((g) => g.name).sort();
        return {
            contents: [
                {
                    uri: 'autoscaler://groups',
                    mimeType: 'application/json',
                    text: JSON.stringify(names, null, 2),
                },
            ],
        };
    });

    // Resource template: individual group details
    server.resource(
        'group-details',
        new ResourceTemplate('autoscaler://groups/{name}', { list: undefined }),
        async (uri, { name }) => {
            const groupName = Array.isArray(name) ? name[0] : name;
            const group = await client.getGroup(groupName);
            if (!group) {
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: 'text/plain',
                            text: `Group '${groupName}' not found.`,
                        },
                    ],
                };
            }
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify(group, null, 2),
                    },
                ],
            };
        },
    );
}
