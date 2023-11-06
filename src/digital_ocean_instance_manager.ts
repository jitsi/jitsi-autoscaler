import path from 'path';
import { createApiClient } from 'dots-wrapper';
import { IDroplet } from 'dots-wrapper/dist/droplet';

import { InstanceGroup } from './instance_group';
import { Context } from './context';
import { AbstractCloudInstanceManager, CloudInstance } from './cloud_instance_manager';
import { CloudRetryStrategy } from './cloud_manager';

export interface DigitalOceanInstanceManagerOptions {
    isDryRun: boolean;
    digitalOceanAPIToken: string;
    digitalOceanConfigurationFilePath: string;
}

interface DigitalOceanConfigLine {
    size: string;
    image: string | number;
    ssh_keys?: string[];
    backups?: boolean;
    ipv6?: boolean;
    private_networking?: boolean;
    vpc_uuid?: string;
    user_data?: string;
    monitoring?: boolean;
    volumes?: string[];
    tags?: string[];
}

type DigitalOceanConfig = Record<string, DigitalOceanConfigLine>;

type DoClient = ReturnType<typeof createApiClient>;

export default class DigitalOceanInstanceManager extends AbstractCloudInstanceManager {
    private isDryRun: boolean;
    private doClient: DoClient;
    private digitalOceanConfig: DigitalOceanConfig;

    constructor(options: DigitalOceanInstanceManagerOptions) {
        super();
        this.isDryRun = options.isDryRun;
        this.doClient = createApiClient({ token: options.digitalOceanAPIToken });

        const fullPath = options.digitalOceanConfigurationFilePath.startsWith('/')
            ? options.digitalOceanConfigurationFilePath
            : path.join(process.cwd(), options.digitalOceanConfigurationFilePath);
        this.digitalOceanConfig = require(fullPath);
    }

    async launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

        const displayName = groupName + '-' + AbstractCloudInstanceManager.makeRandomString(5);

        ctx.logger.info(`[custom] Launching instance number ${index + 1} in group ${groupName} with properties`, {
            groupName,
            displayName,
            groupInstanceConfigurationId,
        });

        if (this.isDryRun) {
            ctx.logger.info(`[custom] Dry run enabled, skipping the instance number ${index + 1} launch`);
            return true;
        }
        try {
            const typeConfig = this.digitalOceanConfig[group.type];

            if (!typeConfig) {
                ctx.logger.error(
                    `[custom] Failed launching instance number ${
                        index + 1
                    } in group ${groupName}: no configuration for instance type ${group.type}`,
                );
                return false;
            }
            const tags = [...(typeConfig.tags || []), `group:${group.name}`];
            const options = {
                name: displayName,
                region: group.region,
                ...typeConfig,
                tags,
            };

            const {
                data: { droplet },
            } = await this.doClient.droplet.createDroplet(options);

            ctx.logger.info(
                `[custom] Got launch response for instance number ${index + 1} in group ${groupName}: ${droplet.id}`,
            );

            return `${droplet.id}`;
        } catch (err) {
            ctx.logger.error(
                `[custom] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
                { err },
            );
            return false;
        }
    }

    async getInstances(
        ctx: Context,
        group: InstanceGroup,
        _cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<CloudInstance[]> {
        const {
            data: { droplets },
        } = await this.doClient.droplet.listDroplets({
            per_page: 100,
            tag_name: `group:${group.name}`,
        });

        return droplets.map((droplet: IDroplet) => ({
            instanceId: `${droplet.id}`,
            displayName: droplet.name,
            cloudStatus: DigitalOceanInstanceManager.mapStatus(droplet.status),
        }));
    }

    private static mapStatus(status: string) {
        switch (status) {
            case 'new':
                return 'Provisioning';
            case 'active':
                return 'Running';
            case 'off':
            case 'archive':
            default:
                return 'Terminated';
        }
    }
}
