import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AutoscalerApiClient } from '../api_client';
import { registerSearchGroups } from './search_groups';
import { registerDescribeGroup } from './describe_group';
import { registerGetGroupReport } from './get_group_report';
import { registerGetGroupAudit } from './get_group_audit';
import { registerCreateGroup } from './create_group';
import { registerUpdateGroup } from './update_group';
import {
    registerUpdateScalingOptions,
    registerUpdateDesiredCount,
    registerUpdateScalingActivities,
} from './update_scaling';
import { registerDeleteGroup } from './delete_group';
import { registerUpdateScheduledScaling } from './update_scheduled_scaling';

export function registerAllTools(server: McpServer, client: AutoscalerApiClient): void {
    registerSearchGroups(server, client);
    registerDescribeGroup(server, client);
    registerGetGroupReport(server, client);
    registerGetGroupAudit(server, client);
    registerCreateGroup(server, client);
    registerUpdateGroup(server, client);
    registerUpdateScalingOptions(server, client);
    registerUpdateDesiredCount(server, client);
    registerUpdateScalingActivities(server, client);
    registerUpdateScheduledScaling(server, client);
    registerDeleteGroup(server, client);
}
