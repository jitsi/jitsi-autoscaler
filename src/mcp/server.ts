import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import config from './config';
import { AutoscalerApiClient } from './api_client';
import { registerAllTools } from './tools';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';

async function main(): Promise<void> {
    const client = new AutoscalerApiClient(config.MCP_AUTOSCALER_BASE_URL, config.MCP_AUTH_TOKEN);

    const server = new McpServer({
        name: 'jitsi-autoscaler',
        version: '1.0.0',
    });

    registerAllTools(server, client);
    registerResources(server, client);
    registerPrompts(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('MCP server failed to start:', error);
    process.exit(1);
});
