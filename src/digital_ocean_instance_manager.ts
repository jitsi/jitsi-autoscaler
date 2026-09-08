import path from 'path';
import { createApiClient } from 'dots-wrapper';
import { IDroplet } from 'dots-wrapper/dist/droplet';

import { Context } from './context';
import {
    AbstractCloudInstanceManager,
    CloudInstance,
    DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS,
} from './cloud_instance_manager';
import { CloudRetryStrategy } from './cloud_manager';
import { InstanceGroup } from './instance_store';

export interface DigitalOceanInstanceManagerOptions {
    isDryRun: boolean;
    digitalOceanAPIToken: string;
    digitalOceanConfigurationFilePath: string;
    // per-request HTTP timeout for the DigitalOcean API
    cloudProviderRequestTimeoutMs?: number;
    // test seams: bypass API client construction / config file loading
    doClient?: DoClient;
    digitalOceanConfig?: DigitalOceanConfig;
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

export type DigitalOceanConfig = Record<string, DigitalOceanConfigLine>;

export type DoClient = ReturnType<typeof createApiClient>;

// DigitalOcean caps per_page at 200
const DO_PAGE_SIZE = 200;
// hard stop for pagination, in case the API keeps handing back a next link
const DO_MAX_PAGES = 100;

export default class DigitalOceanInstanceManager extends AbstractCloudInstanceManager {
    private isDryRun: boolean;
    private doClient: DoClient;
    private digitalOceanConfig: DigitalOceanConfig;

    constructor(options: DigitalOceanInstanceManagerOptions) {
        super();
        this.isDryRun = options.isDryRun;
        this.doClient =
            options.doClient ??
            createApiClient({
                token: options.digitalOceanAPIToken,
                requestTimeoutInMs: options.cloudProviderRequestTimeoutMs ?? DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS,
            });

        if (options.digitalOceanConfig) {
            this.digitalOceanConfig = options.digitalOceanConfig;
        } else {
            const fullPath = options.digitalOceanConfigurationFilePath.startsWith('/')
                ? options.digitalOceanConfigurationFilePath
                : path.join(process.cwd(), options.digitalOceanConfigurationFilePath);
            this.digitalOceanConfig = require(fullPath);
        }
    }

    async launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

        const displayName = groupName + '-' + AbstractCloudInstanceManager.makeRandomString(5);

        ctx.logger.info(`[digitalocean] Launching instance number ${index + 1} in group ${groupName} with properties`, {
            groupName,
            displayName,
            groupInstanceConfigurationId,
        });

        if (this.isDryRun) {
            ctx.logger.info(`[digitalocean] Dry run enabled, skipping the instance number ${index + 1} launch`);
            return true;
        }
        try {
            const typeConfig = this.digitalOceanConfig[group.type];

            if (!typeConfig) {
                ctx.logger.error(
                    `[digitalocean] Failed launching instance number ${
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
                `[digitalocean] Got launch response for instance number ${index + 1} in group ${groupName}: ${
                    droplet.id
                }`,
            );

            return `${droplet.id}`;
        } catch (err) {
            ctx.logger.error(
                `[digitalocean] Failed launching instance number ${index + 1} in group ${groupName} with err ${err}`,
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
        const droplets: IDroplet[] = [];

        // the droplet listing is paged; keep following links.pages.next until exhausted
        let page = 1;
        for (;;) {
            const { data } = await this.doClient.droplet.listDroplets({
                page,
                per_page: DO_PAGE_SIZE,
                tag_name: `group:${group.name}`,
            });
            droplets.push(...(data.droplets || []));
            if (!data.links?.pages?.next) {
                break;
            }
            if (page >= DO_MAX_PAGES) {
                ctx.logger.warn(
                    `[digitalocean] Stopped paging droplet listing for group ${group.name} after ${page} pages, results may be incomplete`,
                );
                break;
            }
            page++;
        }

        return droplets.map((droplet: IDroplet) => ({
            instanceId: `${droplet.id}`,
            displayName: droplet.name,
            cloudStatus: DigitalOceanInstanceManager.mapStatus(droplet.status),
        }));
    }

    /**
     * Map a droplet status to the autoscaler's cloud status vocabulary (compared
     * case-insensitively by consumers). Only statuses that mean the droplet is gone map to
     * TERMINATED; a powered-off or archived droplet still exists and is billed, so it must
     * stay visible to the sanity loop rather than being reported as terminated.
     */
    static mapStatus(status: string): string {
        switch (status) {
            case 'new':
                return 'PROVISIONING';
            case 'active':
                return 'RUNNING';
            case 'off':
                return 'STOPPED';
            case 'archive':
                return 'ARCHIVED';
            default:
                return status ? status.toUpperCase() : 'UNKNOWN';
        }
    }
}
