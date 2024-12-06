import Consul from 'consul';
import { Context } from './context';
import { GetItem } from 'consul/lib/kv';
import InstanceStore, { InstanceGroup } from './instance_store';

// implments the InstanceStore interface using consul K/V API calls
// uses the got library to make HTTP requests

export interface ConsulOptions {
    host: string;
    port: number;
    secure: boolean;
    groupsPrefix?: string;
}

export default class ConsulStore {
    private client: Consul;
    private groupsPrefix = 'autoscaler/groups/';

    constructor(options: ConsulOptions) {
        this.client = new Consul(options);
        if (options.groupsPrefix) {
            this.groupsPrefix = options.groupsPrefix;
        }
    }

    async getInstanceGroup(ctx: Context, group: string): Promise<InstanceGroup> {
        try {
            const { Value } = await this.fetch(ctx, `${this.groupsPrefix}${group}`);
            return <InstanceGroup>JSON.parse(Value);
        } catch (err) {
            ctx.logger.error(`Failed to get instance group from consul: ${err}`, { err });
            throw err;
        }
    }

    async getAllInstanceGroups(ctx: Context): Promise<InstanceGroup[]> {
        try {
            const keys = await this.fetchInstanceGroups(ctx);
            const groups = await Promise.all(keys.map((key) => this.getInstanceGroup(ctx, key)));
            return groups;
        } catch (err) {
            ctx.logger.error(`Failed to get all instance groups from consul: ${err}`, { err });
            throw err;
        }
    }

    async fetchInstanceGroups(ctx: Context): Promise<string[]> {
        ctx.logger.debug('fetching consul k/v keys');
        const res = await this.client.kv.get({ key: this.groupsPrefix, recurse: true });
        ctx.logger.debug('received consul k/v keys', { res });
        if (!res) {
            return [];
        }
        return Object.entries(res).map(([_k, v]) => v.Key.replace(this.groupsPrefix, ''));
    }

    async upsertInstanceGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        try {
            await this.write(ctx, `${this.groupsPrefix}${group.name}`, JSON.stringify(group));
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to upsert instance group into consul: ${err}`, { group: group.name, err });
            return false;
        }
    }

    async deleteInstanceGroup(ctx: Context, group: string): Promise<boolean> {
        try {
            await this.delete(`${this.groupsPrefix}${group}`);
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to delete instance group from consul: ${err}`, { group, err });
            return false;
        }
    }

    async fetch(ctx: Context, key: string): Promise<GetItem | undefined> {
        ctx.logger.debug(`reading consul k/v key`, { key });
        const v = await this.client.kv.get(key);
        ctx.logger.debug(`received consul k/v item`, { v });
        return v;
    }

    async write(ctx: Context, key: string, value: string): Promise<boolean> {
        try {
            const res = await this.client.kv.set(key, value);
            if (!res) {
                ctx.logger.error(`Failed to write to consul`);
            }
            return res;
        } catch (err) {
            ctx.logger.error(`Failed to write to consul: ${err}`, { err });
            return false;
        }
    }

    async delete(key: string): Promise<boolean> {
        await this.client.kv.del(key);
        return true;
    }
}
