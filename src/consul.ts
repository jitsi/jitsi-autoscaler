import Consul from 'consul';
import { Context } from './context';
import { GetItem } from 'consul/lib/kv';
import InstanceStore, { InstanceDetails, InstanceGroup, InstanceState } from './instance_store';
import { CloudInstance } from './cloud_manager';
import { Reservation } from './reservation';
import { ReservationStore } from './reservation_store';
import { partitionExpiredStates } from './instance_state_expiry';

// implments the InstanceStore interface using consul K/V API calls
// uses the got library to make HTTP requests

export interface ConsulOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    groupsPrefix?: string;
    groupDataPrefix?: string;
    valuesPrefix?: string;
    client?: Consul;
    // Instance-state expiry TTLs (seconds), mirroring the Redis store. See filterOutAndTrimExpiredStates.
    idleTTL?: number;
    provisioningTTL?: number;
    shutdownStatusTTL?: number;
}

interface TTLValue {
    expires: number;
    status: string;
}

interface TTLValueMap {
    [key: string]: TTLValue;
}

// NOTE: Consul TTL semantics are wall-clock timestamps compared client-side (see writeTTLValue /
// fetchTTLValue, which compare `expires` against Date.now()). Consul mode therefore requires
// synchronized clocks across all autoscaler nodes; skewed clocks cause premature or delayed expiry.
export default class ConsulStore implements InstanceStore, ReservationStore {
    private client: Consul;
    // Group definitions live under groupsPrefix; all per-group data (states, shutdown, confirmation,
    // protected, reconfigure, cloud instances) lives under groupDataPrefix. Keeping them in separate
    // trees prevents recursive group listings from parsing instance data as phantom InstanceGroups.
    private groupsPrefix = 'autoscaler/groups/';
    private groupDataPrefix = 'autoscaler/group-data/';
    private valuesPrefix = 'autoscaler/values/';
    private reservationsPrefix = 'autoscaler/reservations/';
    private idleTTL = 300;
    private provisioningTTL = 900;
    private shutdownStatusTTL = 600;

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
        if (options.groupDataPrefix) {
            this.groupDataPrefix = options.groupDataPrefix;
        }
        if (options.valuesPrefix) {
            this.valuesPrefix = options.valuesPrefix;
        }
        if (options.idleTTL !== undefined) {
            this.idleTTL = options.idleTTL;
        }
        if (options.provisioningTTL !== undefined) {
            this.provisioningTTL = options.provisioningTTL;
        }
        if (options.shutdownStatusTTL !== undefined) {
            this.shutdownStatusTTL = options.shutdownStatusTTL;
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
                    `${this.groupDataPrefix}${instance.group}/shutdown/${instance.instanceId}`,
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
        return this.fetchRecursiveTTLValues(ctx, `${this.groupDataPrefix}${group}/shutdown`, clean);
    }

    async getShutdownStatuses(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        const groupShutdownInstanceIds = Object.keys(await this.fetchShutdownStatus(ctx, group));
        return instanceIds.map((instanceId) => groupShutdownInstanceIds.includes(instanceId));
    }

    async fetchShutdownConfirmations(ctx: Context, group: string): Promise<TTLValueMap> {
        return this.fetchRecursiveTTLValues(ctx, `${this.groupDataPrefix}${group}/confirmation`);
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
        const v = await this.fetchTTLValue(ctx, `${this.groupDataPrefix}${group}/shutdown/${instanceId}`);
        return v !== undefined;
    }

    async getShutdownConfirmation(ctx: Context, group: string, instanceId: string): Promise<false | string> {
        const v = await this.fetchTTLValue(ctx, `${this.groupDataPrefix}${group}/confirmation/${instanceId}`);
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
                    `${this.groupDataPrefix}${instance.group}/confirmation/${instance.instanceId}`,
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
        return this.writeTTLValue(ctx, `${this.groupDataPrefix}${group}/protected/${instanceId}`, mode, protectedTTL);
    }

    async areScaleDownProtected(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        const res = await this.fetchRecursiveTTLValues(ctx, `${this.groupDataPrefix}${group}/protected`);
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
            p.push(
                this.writeTTLValue(
                    ctx,
                    `${this.groupDataPrefix}${instance.group}/reconfigure/${instance.instanceId}`,
                    date,
                    ttl,
                ),
            );
        }

        return (await Promise.allSettled(p))
            .map((r) => r.status === 'fulfilled' && r.value === true)
            .reduce((a, b) => a && b, true);
    }

    async unsetReconfigureDate(ctx: Context, instanceId: string, group: string): Promise<boolean> {
        return this.delete(`${this.groupDataPrefix}${group}/reconfigure/${instanceId}`);
    }

    async getReconfigureDates(ctx: Context, group: string, instanceIds: string[]): Promise<string[]> {
        // fetchRecursiveTTLValues keys its map by the stripped (bare instance id) key.
        const res = await this.fetchRecursiveTTLValues(ctx, `${this.groupDataPrefix}${group}/reconfigure`);
        return instanceIds.map((instanceId) => {
            const reconfigure = res[instanceId];
            if (reconfigure) {
                return reconfigure.status;
            } else {
                return '';
            }
        });
    }
    async getReconfigureDate(ctx: Context, group: string, instanceId: string): Promise<string> {
        try {
            // Use fetchTTLValue so an expired reconfigure date reads as '' (it checks the expiry).
            const v = await this.fetchTTLValue(ctx, `${this.groupDataPrefix}${group}/reconfigure/${instanceId}`);
            return v?.status ?? '';
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
        // A group definition key is `${groupsPrefix}<name>` with no further nesting. Older builds wrote
        // per-group data (states/shutdown/...) under this same prefix; skip any such leftover nested keys
        // so they aren't parsed as phantom groups named e.g. `jvb-east/states/i-123`.
        return Object.entries(res)
            .map(([_k, v]) => v.Key.replace(this.groupsPrefix, ''))
            .filter((name) => name.length > 0 && !name.includes('/'));
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
        // Only bare `${groupsPrefix}<name>` keys are group definitions; skip nested legacy data keys and a
        // bare prefix placeholder (empty name, e.g. a directory key created via the Consul UI) so instance
        // data / empty values are never cast to a phantom InstanceGroup or crash JSON.parse.
        return Object.entries(res)
            .filter(([_k, v]) => {
                const name = v.Key.replace(this.groupsPrefix, '');
                return name.length > 0 && !name.includes('/');
            })
            .map(([_k, v]) => <InstanceGroup>JSON.parse(v.Value));
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
            // Delete the group definition, the whole per-group data subtree, the reservations subtree, and
            // the scale-down grace flag. Reservations and the grace flag live outside groupDataPrefix, so
            // omitting them would resurrect stale reservations (TTL expiry+3600s) if the group is recreated.
            await this.delete(`${this.groupsPrefix}${group}`);
            await this.client.kv.del({ key: `${this.groupDataPrefix}${group}/`, recurse: true });
            await this.client.kv.del({ key: `${this.reservationsPrefix}${group}/`, recurse: true });
            await this.delete(`${this.valuesPrefix}reservation-scaledown-grace:${group}`);
            return;
        } catch (err) {
            ctx.logger.error(`Failed to delete instance group from consul: ${err}`, { group, err });
            return;
        }
    }

    async fetchInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        try {
            const states = await this.client.kv.get({ key: `${this.groupDataPrefix}${group}/states`, recurse: true });
            // kv.get returns undefined when no keys match; Object.entries(undefined) would throw.
            if (!states) {
                return [];
            }
            const rawStates = Object.entries(states).map(([_k, v]) => <InstanceState>JSON.parse(v.Value));
            return this.filterOutAndTrimExpiredStates(ctx, group, rawStates);
        } catch (err) {
            ctx.logger.error(`Failed to get instance states from consul: ${err}`, { err });
            throw err;
        }
    }

    // Uses the shared expiry policy (see instance_state_expiry.ts) so Consul and Redis stay in lockstep,
    // then deletes the expired state keys from Consul.
    async filterOutAndTrimExpiredStates(
        ctx: Context,
        group: string,
        states: InstanceState[],
    ): Promise<InstanceState[]> {
        // Skip the recursive shutdown-status fetch entirely for idle/empty groups. Trade-off: this also
        // skips reaping expired shutdown-status entries for a scaled-to-zero group, so a small, bounded set
        // of expired keys may linger under group-data/<group>/shutdown until the group scales back up (the
        // next non-empty pass reaps them) or is deleted (deleteInstanceGroup drops the whole subtree).
        if (states.length === 0) {
            return [];
        }
        const shutdownStatuses = await this.getShutdownStatuses(
            ctx,
            group,
            states.map((state) => state.instanceId),
        );

        const { valid, expired } = partitionExpiredStates(
            ctx,
            group,
            states,
            shutdownStatuses,
            { idleTTL: this.idleTTL, provisioningTTL: this.provisioningTTL, shutdownStatusTTL: this.shutdownStatusTTL },
            Date.now(),
        );

        const p = expired.map((state) => {
            ctx.logger.debug(`will delete expired state`, { group, state });
            return this.delete(`${this.groupDataPrefix}${group}/states/${state.instanceId}`);
        });
        (await Promise.allSettled(p)).map((r) => {
            if (r.status === 'rejected') {
                ctx.logger.error(`Failed to delete expired state from consul: ${r.reason}`, { group });
            }
        });
        return valid;
    }

    async saveInstanceStatus(ctx: Context, group: string, state: InstanceState): Promise<boolean> {
        try {
            await this.write(ctx, `${this.groupDataPrefix}${group}/states/${state.instanceId}`, JSON.stringify(state));
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
        // Track the full Consul path and ModifyIndex per short key so expired entries are deleted by their
        // real key (not the stripped instance id, which is a no-op) and only via a CAS that fails if the
        // value changed since we read it.
        const meta: { [shortKey: string]: { fullKey: string; modifyIndex: number } } = {};
        (await this.fetchRecursive(ctx, key)).map((v) => {
            const shortKey = v.Key.replace(`${key}/`, '');
            values[shortKey] = <TTLValue>JSON.parse(v.Value);
            meta[shortKey] = { fullKey: v.Key, modifyIndex: v.ModifyIndex };
        });
        if (clean) {
            const p: Promise<boolean>[] = [];
            Object.entries(values).map(([k, v]) => {
                if (v.expires <= Date.now()) {
                    // CAS-guarded delete: if a concurrent writer refreshed this key between the fetch above
                    // and here (e.g. setShutdownStatus re-setting the same key), the ModifyIndex no longer
                    // matches and Consul rejects the delete, so we never drop a live value. We still exclude
                    // it from this read's result (the value we hold is the expired one); the next read picks
                    // up the refreshed value.
                    p.push(this.deleteCas(meta[k].fullKey, meta[k].modifyIndex));
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

    // The value is considered expired if the timestamp is in the past. Errors are allowed to propagate
    // (matching RedisStore.checkValue): swallowing them here would read a Consul outage as "flag not set",
    // so scale-down protection and reservation grace flags would fail open and let protected/reserved
    // instances be scaled down while the store is broken. Callers already skip the cycle on a throw.
    async checkValue(ctx: Context, key: string): Promise<boolean> {
        const res = await this.fetchTTLValue(ctx, this.valuesPrefix + key);
        return res !== undefined;
    }

    // save cloud instances
    async saveCloudInstances(ctx: Context, group: string, instances: CloudInstance[]): Promise<boolean> {
        try {
            await this.write(ctx, `${this.groupDataPrefix}${group}/instances`, JSON.stringify(instances));
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to save cloud instances into consul: ${err}`, { group, instances, err });
            return false;
        }
    }

    async existsAtLeastOneGroup(ctx: Context): Promise<boolean> {
        const names = await this.getAllInstanceGroupNames(ctx);
        return names && names.length > 0;
    }

    async delete(key: string): Promise<boolean> {
        await this.client.kv.del(key);
        return true;
    }

    // CAS-guarded delete: only removes the key if its ModifyIndex still matches (i.e. it hasn't been
    // rewritten since it was read). Returns false when the CAS check fails, without throwing.
    async deleteCas(key: string, modifyIndex: number): Promise<boolean> {
        return this.client.kv.del({ key, cas: modifyIndex });
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

    // Reservation store methods

    private reservationKey(groupName: string, id: string): string {
        return `${this.reservationsPrefix}${groupName}/${id}`;
    }

    async saveReservation(ctx: Context, reservation: Reservation): Promise<void> {
        const ttl = Math.max(Math.ceil((reservation.expiresAt - Date.now()) / 1000) + 3600, 3600);
        await this.writeTTLValue(
            ctx,
            this.reservationKey(reservation.groupName, reservation.id),
            JSON.stringify(reservation),
            ttl,
        );
    }

    async getReservation(ctx: Context, id: string): Promise<Reservation | null> {
        // Since we don't know the group name, search all reservations
        const items = await this.fetchRecursive(ctx, this.reservationsPrefix);
        for (const item of items) {
            if (item.Key.endsWith(`/${id}`)) {
                const ttlValue = JSON.parse(item.Value) as TTLValue;
                if (ttlValue.expires > Date.now()) {
                    return JSON.parse(ttlValue.status);
                }
                // Expired reservation: clean it up (by its full key) rather than leaving it in the KV.
                try {
                    await this.delete(item.Key);
                } catch (err) {
                    ctx.logger.error(`Failed to delete expired reservation from consul`, { id, key: item.Key, err });
                }
                return null;
            }
        }
        return null;
    }

    async listReservations(ctx: Context, groupName: string): Promise<Reservation[]> {
        const key = `${this.reservationsPrefix}${groupName}`;
        const ttlValues = await this.fetchRecursiveTTLValues(ctx, key, true);
        return Object.values(ttlValues).map((v) => JSON.parse(v.status) as Reservation);
    }

    async deleteReservation(ctx: Context, id: string, groupName: string): Promise<void> {
        try {
            await this.delete(this.reservationKey(groupName, id));
        } catch (err) {
            ctx.logger.error(`Failed to delete reservation from consul`, { id, groupName, err });
        }
    }

    async setScaleDownGrace(ctx: Context, groupName: string, ttlSec: number): Promise<void> {
        await this.setValue(ctx, `reservation-scaledown-grace:${groupName}`, 'active', ttlSec);
    }

    async isScaleDownGraceActive(ctx: Context, groupName: string): Promise<boolean> {
        return this.checkValue(ctx, `reservation-scaledown-grace:${groupName}`);
    }
}
