import { InstanceGroup } from './instance_group';
import { Context } from './context';
import { createApiClient } from 'dots-wrapper';
import path from 'path';
import { IDroplet } from 'dots-wrapper/dist/modules/droplet';

function makeRandomString(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

export interface DigitalOceanInstanceManagerOptions {
    isDryRun: boolean;
    digitalOceanAPIToken: string;
    digitalOceanConfigurationFilePath: string;
}

export interface DigitalOceanCloudInstance {
    instanceId: string;
    displayName: string;
    cloudStatus: string;
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

export default class DigitalOceanInstanceManager {
    private isDryRun: boolean;
    private doClient: DoClient;
    private digitalOceanConfig: DigitalOceanConfig;

    constructor(options: DigitalOceanInstanceManagerOptions) {
        this.isDryRun = options.isDryRun;
        this.doClient = createApiClient({ token: options.digitalOceanAPIToken });

        this.digitalOceanConfig = require(path.join('..', '..', options.digitalOceanConfigurationFilePath));
        this.launchInstances = this.launchInstances.bind(this);
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[custom] Launching a batch of ${quantity} instances in group ${group.name}`);

        const indexes: Array<number> = [];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        const result = await Promise.all(
            indexes.map(async (index) => {
                return this.launchInstance(ctx, index, group);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);

        return result;
    }

    async launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean> {
        const groupName = group.name;
        const groupInstanceConfigurationId = group.instanceConfigurationId;

        const displayName = groupName + '-' + makeRandomString(5);

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
            const options = {
                name: displayName,
                region: group.region,
                ...typeConfig,
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

    async getInstances(): Promise<DigitalOceanCloudInstance[]> {
        const {
            data: { droplets },
        } = await this.doClient.droplet.listDroplets({
            per_page: 100,
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
