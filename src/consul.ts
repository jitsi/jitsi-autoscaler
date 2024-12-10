import Consul from 'consul';
import { Context } from './context';
import { GetItem } from 'consul/lib/kv';
import InstanceStore, { InstanceDetails, InstanceGroup, InstanceState } from './instance_store';
import { CloudInstance } from './cloud_manager';

// implments the InstanceStore interface using consul K/V API calls
// uses the got library to make HTTP requests

export interface ConsulOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    groupsPrefix?: string;
    valuesPrefix?: string;
    instancesPrefix?: string;
    client?: Consul;
}

interface TTLValue {
    expires: number;
    status: string;
}

interface TTLValueMap {
    [key: string]: TTLValue;
}

export default class ConsulStore implements InstanceStore {
    private client: Consul;
    private groupsPrefix = 'autoscaler/groups/';
    private valuesPrefix = 'autoscaler/values/';
    private instancesPrefix = 'autoscaler/instances/';

    constructor(options: ConsulOptions) {
        if (!options.client && (!options.host || !options.port)) {
            throw new Error('Consul client or at least host and port must be provided to ConsulStore');
        }
        if (options.client) {
            this.client = options.client;
        } else {
            this.client = new Consul(options);
        }
        if (options.groupsPrefix) {
            this.groupsPrefix = options.groupsPrefix;
        }
        if (options.valuesPrefix) {
            this.valuesPrefix = options.valuesPrefix;
        }
        if (options.instancesPrefix) {
            this.instancesPrefix = options.instancesPrefix;
        }
    }

    // shutdown related methods
    async setShutdownStatus(
        ctx: Context,
        instanceDetails: InstanceDetails[],
        status: string,
        ttl: number,
    ): Promise<boolean> {
        const p: Promise<boolean>[] = [];
        for (const instance of instanceDetails) {
            ctx.logger.debug(`setting shutdown status for instance`, { instance, status });
            p.push(
                this.writeTTLValue(
                    ctx,
                    `${this.groupsPrefix}${instance.group}/shutdown/${instance.instanceId}`,
                    status,
                    ttl,
                ),
            );
        }

        return (await Promise.allSettled(p))
            .map((r) => r.status === 'fulfilled' && r.value === true)
            .reduce((a, b) => a && b, true);
    }

    async fetchShutdownStatus(ctx: Context, group: string, clean = true): Promise<TTLValueMap> {
        return this.fetchRecursiveTTLValues(ctx, `${this.groupsPrefix}${group}/shutdown`, clean);
    }

    async getShutdownStatuses(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        const groupShutdownInstanceIds = Object.keys(await this.fetchShutdownStatus(ctx, group));
        return instanceIds.map((instanceId) => groupShutdownInstanceIds.includes(instanceId));
    }

    async fetchShutdownConfirmations(ctx: Context, group: string): Promise<TTLValueMap> {
        return this.fetchRecursiveTTLValues(ctx, `${this.groupsPrefix}${group}/confirmation`);
    }

    async getShutdownConfirmations(ctx: Context, group: string, instanceIds: string[]): Promise<(string | false)[]> {
        const groupShutdownConfirmations = await this.fetchShutdownConfirmations(ctx, group);
        return instanceIds.map((instanceId) => {
            const confirmation = groupShutdownConfirmations[instanceId];
            if (confirmation) {
                return confirmation.status;
            } else {
                return false;
            }
        });
    }

    async getShutdownStatus(ctx: Context, group: string, instanceId: string): Promise<boolean> {
        const v = await this.fetchTTLValue(ctx, `${this.groupsPrefix}${group}/shutdown/${instanceId}`);
        return v !== undefined;
    }

    async getShutdownConfirmation(ctx: Context, group: string, instanceId: string): Promise<false | string> {
        const v = await this.fetchTTLValue(ctx, `${this.groupsPrefix}${group}/confirmation/${instanceId}`);
        if (v) {
            return v.status;
        } else {
            return false;
        }
    }

    async setShutdownConfirmation(
        ctx: Context,
        instanceDetails: InstanceDetails[],
        status: string,
        ttl: number,
    ): Promise<boolean> {
        const p: Promise<boolean>[] = [];
        for (const instance of instanceDetails) {
            ctx.logger.debug(`setting shutdown confirmation for instance`, { instance, status });
            p.push(
                this.writeTTLValue(
                    ctx,
                    `${this.groupsPrefix}${instance.group}/confirmation/${instance.instanceId}`,
                    status,
                    ttl,
                ),
            );
        }

        return (await Promise.allSettled(p))
            .map((r) => r.status === 'fulfilled' && r.value === true)
            .reduce((a, b) => a && b, true);
    }

    async setScaleDownProtected(
        ctx: Context,
        group: string,
        instanceId: string,
        protectedTTL: number,
        mode: string,
    ): Promise<boolean> {
        return this.writeTTLValue(ctx, `${this.groupsPrefix}${group}/protected/${instanceId}`, mode, protectedTTL);
    }

    async areScaleDownProtected(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        const res = await this.fetchRecursiveTTLValues(ctx, `${this.groupsPrefix}${group}/protected`);
        const scaleProtectedInstances = Object.keys(res);

        return instanceIds.map((instanceId) => scaleProtectedInstances.includes(instanceId));
    }

    // reconfigure related methods
    async setReconfigureDate(
        ctx: Context,
        instanceDetails: InstanceDetails[],
        date: string,
        ttl: number,
    ): Promise<boolean> {
        const p = <Promise<boolean>[]>[];
        for (const instance of instanceDetails) {
            p.push(this.writeTTLValue(ctx, `${this.instancesPrefix}/reconfigure/${instance.instanceId}`, date, ttl));
        }

        return (await Promise.allSettled(p))
            .map((r) => r.status === 'fulfilled' && r.value === true)
            .reduce((a, b) => a && b, true);
    }

    async unsetReconfigureDate(ctx: Context, instanceId: string, group: string): Promise<boolean> {
        return this.delete(`${this.groupsPrefix}${group}/reconfigure/${instanceId}`);
    }

    async getReconfigureDates(ctx: Context, group: string, instanceIds: string[]): Promise<string[]> {
        const res = await this.fetchRecursiveTTLValues(ctx, `${this.groupsPrefix}${group}/reconfigure`);
        return instanceIds.map((instanceId) => {
            const reconfigure = res[`${this.groupsPrefix}${group}/reconfigure/${instanceId}`];
            if (reconfigure) {
                return reconfigure.status;
            } else {
                return '';
            }
        });
    }
    async getReconfigureDate(ctx: Context, group: string, instanceId: string): Promise<string> {
        try {
            const v = await this.fetch(ctx, `${this.groupsPrefix}${group}/reconfigure/${instanceId}`);
            if (v) {
                const reconfigure = JSON.parse(v.Value);
                return reconfigure.status;
            } else {
                return '';
            }
        } catch (err) {
            ctx.logger.error(`Failed to get reconfigure date from consul: ${err}`, { err });
            throw err;
        }
    }

    async getInstanceGroup(ctx: Context, group: string): Promise<InstanceGroup> {
        try {
            const v = await this.fetch(ctx, `${this.groupsPrefix}${group}`);
            if (v) {
                return <InstanceGroup>JSON.parse(v.Value);
            } else {
                return undefined;
            }
        } catch (err) {
            ctx.logger.error(`Failed to get instance group from consul: ${err}`, { err });
            throw err;
        }
    }

    async getAllInstanceGroupNames(ctx: Context): Promise<string[]> {
        const res = await this.fetchRecursive(ctx, this.groupsPrefix);
        if (!res) {
            return [];
        }
        return Object.entries(res).map(([_k, v]) => v.Key.replace(this.groupsPrefix, ''));
    }

    async getAllInstanceGroups(ctx: Context): Promise<InstanceGroup[]> {
        ctx.logger.debug('fetching consul k/v keys');
        const key = this.groupsPrefix;
        const res = await this.client.kv.get({ key, recurse: true });
        if (!res) {
            ctx.logger.debug('received consul k/v results', { key });
            return [];
        }
        ctx.logger.debug('received consul k/v results', { key, res });
        return Object.entries(res).map(([_k, v]) => <InstanceGroup>JSON.parse(v.Value));
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

    async deleteInstanceGroup(ctx: Context, group: string): Promise<void> {
        try {
            await this.delete(`${this.groupsPrefix}${group}`);
            return;
        } catch (err) {
            ctx.logger.error(`Failed to delete instance group from consul: ${err}`, { group, err });
            return;
        }
    }

    async fetchInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        try {
            const states = await this.client.kv.get({ key: `${this.groupsPrefix}${group}/states`, recurse: true });
            return Object.entries(states).map(([_k, v]) => <InstanceState>JSON.parse(v.Value));
        } catch (err) {
            ctx.logger.error(`Failed to get instance states from consul: ${err}`, { err });
            throw err;
        }
    }

    // TODO: implement this method
    async filterOutAndTrimExpiredStates(
        _ctx: Context,
        _group: string,
        states: InstanceState[],
    ): Promise<InstanceState[]> {
        return states;
    }

    async saveInstanceStatus(ctx: Context, group: string, state: InstanceState): Promise<boolean> {
        try {
            await this.write(ctx, `${this.groupsPrefix}${group}/states/${state.instanceId}`, JSON.stringify(state));
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to save instance state into consul: ${err}`, { group, state, err });
            return false;
        }
    }

    async fetchRecursive(ctx: Context, key: string): Promise<GetItem[]> {
        try {
            const v = await this.client.kv.get({ key, recurse: true });
            if (!v) {
                return [];
            }
            const obj = Object.entries(v).map(([_k, v]) => v);
            return obj;
        } catch (err) {
            ctx.logger.error(`Failed to read ${key} from consul: ${err}`, { err, key });
            throw err;
            //            return [];
        }
    }

    async fetchRecursiveTTLValues(ctx: Context, key: string, clean = true): Promise<TTLValueMap> {
        const values = <TTLValueMap>{};
        (await this.fetchRecursive(ctx, key)).map((v) => {
            values[v.Key.replace(`${key}/`, '')] = <TTLValue>JSON.parse(v.Value);
        });
        if (clean) {
            const p: Promise<boolean>[] = [];
            Object.entries(values).map(([k, v]) => {
                if (v.expires <= Date.now()) {
                    p.push(this.delete(k));
                    delete values[k];
                }
            });
            (await Promise.allSettled(p)).map((r) => {
                if (r.status === 'rejected') {
                    ctx.logger.error(`Failed to delete key from consul: ${r.reason}`, { key: r.reason });
                }
            });
        }

        return values;
    }

    async fetchTTLValue(ctx: Context, key: string): Promise<TTLValue | undefined> {
        const v = await this.fetch(ctx, key);
        if (v) {
            const ttlv = <TTLValue>JSON.parse(v.Value);
            if (ttlv.expires > Date.now()) {
                return ttlv;
            } else {
                return undefined;
            }
        }
        return undefined;
    }

    async fetch(ctx: Context, key: string): Promise<GetItem | undefined> {
        ctx.logger.debug(`reading consul k/v key`, { key });
        const v = await this.client.kv.get(key);
        ctx.logger.debug(`received consul k/v item`, { key, v });
        return v;
    }

    async write(ctx: Context, key: string, value: string): Promise<boolean> {
        try {
            const res = await this.client.kv.set(key, value);
            if (!res) {
                ctx.logger.error(`Failed to write to consul`, { key, value });
            }
            return res;
        } catch (err) {
            ctx.logger.error(`Failed to write to consul: ${err}`, { key, err });
            return false;
        }
    }

    async writeTTLValue(ctx: Context, key: string, status: string, ttl: number): Promise<boolean> {
        return this.write(ctx, key, JSON.stringify(<TTLValue>{ status, expires: Date.now() + ttl * 1000 }));
    }

    // save alongside a ttl with the timestamp after which the value is considered expired
    async setValue(ctx: Context, key: string, value: string, ttl: number): Promise<boolean> {
        return this.writeTTLValue(ctx, this.valuesPrefix + key, value, ttl);
    }

    // the value is considered expired if the timestamp is in the past
    async checkValue(ctx: Context, key: string): Promise<boolean> {
        try {
            const res = this.fetchTTLValue(ctx, this.valuesPrefix + key);
            if (!res) {
                return false;
            }
            return true;
        } catch (err) {
            return false;
        }
    }

    // save cloud instances
    async saveCloudInstances(ctx: Context, group: string, instances: CloudInstance[]): Promise<boolean> {
        try {
            await this.write(ctx, `${this.groupsPrefix}${group}/instances`, JSON.stringify(instances));
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to save cloud instances into consul: ${err}`, { group, instances, err });
            return false;
        }
    }

    async existsAtLeastOneGroup(ctx: Context): Promise<boolean> {
        const res = await this.getAllInstanceGroups(ctx);
        return res && res.length > 0;
    }

    async delete(key: string): Promise<boolean> {
        await this.client.kv.del(key);
        return true;
    }

    async ping(ctx: Context): Promise<boolean | string> {
        try {
            await this.client.status.leader();
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to ping consul: ${err}`, { err });
            return err;
        }
    }
}
