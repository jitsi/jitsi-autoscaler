import Consul from 'consul';
import { Context } from './context';
import { GetItem } from 'consul/lib/kv';
import InstanceStore, { InstanceDetails, InstanceGroup, InstanceState } from './instance_store';
import { CloudInstance } from './cloud_manager';
import { Reservation } from './reservation';
import {
    DEFAULT_TERMINAL_RESERVATION_RETENTION_SEC,
    ReservationStore,
    isTerminalReservationStatus,
    terminalReservationTTLSec,
} from './reservation_store';
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
    // Instance-state expiry TTLs (seconds), mirroring the Redis store. See trimExpiredStates.
    idleTTL?: number;
    provisioningTTL?: number;
    shutdownStatusTTL?: number;
    // Seconds a terminal (expired/cancelled) reservation is retained past its expiresAt.
    terminalReservationRetentionSec?: number;
}

interface TTLValue {
    // Wall-clock ms after which the value is considered expired. 0 (or absent) means never expires.
    expires: number;
    status: string;
}

// Never-expire sentinel for TTLValue.expires (see isTTLValueExpired).
const NEVER_EXPIRES = 0;

function isTTLValueExpired(v: TTLValue, now: number): boolean {
    return !!v.expires && v.expires <= now;
}

interface TTLValueMap {
    [key: string]: TTLValue;
}

export interface LegacyGroupDataMigrationSummary {
    moved: number;
    skipped: number;
    deleted: number;
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
    private terminalReservationRetentionSec = DEFAULT_TERMINAL_RESERVATION_RETENTION_SEC;

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
        if (options.terminalReservationRetentionSec !== undefined) {
            this.terminalReservationRetentionSec = options.terminalReservationRetentionSec;
        }
    }

    // Parses a KV item's JSON value. Returns undefined (and warns with the key) for an empty/null value
    // (e.g. a directory-style key created via the Consul UI) or malformed / non-object JSON, so a single
    // bad key cannot fail a whole group read or every reservation lookup.
    private parseItemValue<T>(ctx: Context, item: GetItem, what: string): T | undefined {
        if (!item.Value) {
            ctx.logger.warn(`Skipping ${what} with an empty value in consul`, { key: item.Key });
            return undefined;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(item.Value);
        } catch (err) {
            ctx.logger.warn(`Skipping ${what} with malformed JSON in consul: ${err}`, { key: item.Key, err });
            return undefined;
        }
        if (parsed === null || typeof parsed !== 'object') {
            ctx.logger.warn(`Skipping ${what} with a non-object JSON value in consul`, { key: item.Key });
            return undefined;
        }
        return <T>parsed;
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

        // Writes fail closed (reject) like the Redis pipeline does; a swallowed failure here would let an
        // instance we believe is shutting down keep counting as active.
        await Promise.all(p);
        return true;
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

        await Promise.all(p);
        return true;
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

        await Promise.all(p);
        return true;
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

    // Returns the group name when the item is a group definition, otherwise undefined. A definition is a
    // bare `${groupsPrefix}<name>` key (no further nesting) with a non-empty value. Older builds wrote
    // per-group data (states/shutdown/...) under this same prefix, so nested leftover keys must not be
    // parsed as phantom groups named e.g. `jvb-east/states/i-123`; a bare-prefix placeholder (empty name)
    // and empty-valued keys (e.g. a directory key created via the Consul UI) are skipped for the same
    // reason. Shared by every group listing so the two cannot drift.
    private groupDefinitionName(item: GetItem): string | undefined {
        const name = item.Key.startsWith(this.groupsPrefix) ? item.Key.slice(this.groupsPrefix.length) : item.Key;
        if (name.length === 0 || name.includes('/') || !item.Value) {
            return undefined;
        }
        return name;
    }

    private async fetchGroupDefinitionItems(ctx: Context): Promise<GetItem[]> {
        return (await this.fetchRecursive(ctx, this.groupsPrefix)).filter(
            (item) => this.groupDefinitionName(item) !== undefined,
        );
    }

    async getAllInstanceGroupNames(ctx: Context): Promise<string[]> {
        return (await this.fetchGroupDefinitionItems(ctx)).map((item) => this.groupDefinitionName(item));
    }

    async getAllInstanceGroups(ctx: Context): Promise<InstanceGroup[]> {
        ctx.logger.debug('fetching consul k/v keys');
        const items = await this.fetchGroupDefinitionItems(ctx);
        ctx.logger.debug('received consul k/v results', { key: this.groupsPrefix, res: items });
        const groups: InstanceGroup[] = [];
        for (const item of items) {
            const group = this.parseItemValue<InstanceGroup>(ctx, item, 'instance group');
            if (group) {
                groups.push(group);
            }
        }
        return groups;
    }

    // Write failures propagate (write() logs and rethrows), matching RedisStore: a swallowed failure
    // would report success to the API caller while the group definition was never persisted.
    async upsertInstanceGroup(ctx: Context, group: InstanceGroup): Promise<boolean> {
        await this.write(ctx, `${this.groupsPrefix}${group.name}`, JSON.stringify(group));
        return true;
    }

    async deleteInstanceGroup(ctx: Context, group: string): Promise<void> {
        // Purge every per-group data tree first (in parallel) and the definition LAST, only once all of the
        // data deletes succeeded. Deleting the definition first left orphaned data behind on a transient
        // failure and made the retry 404. Reservations and the grace flag live outside groupDataPrefix, so
        // omitting them would resurrect stale reservations if the group is recreated; the legacy nested
        // subtree under groupsPrefix is from the pre-C2 layout.
        const dataDeletes: { what: string; run: () => Promise<unknown> }[] = [
            {
                what: 'group data',
                run: () => this.client.kv.del({ key: `${this.groupDataPrefix}${group}/`, recurse: true }),
            },
            {
                what: 'reservations',
                run: () => this.client.kv.del({ key: `${this.reservationsPrefix}${group}/`, recurse: true }),
            },
            {
                what: 'scale-down grace flag',
                run: () => this.delete(`${this.valuesPrefix}reservation-scaledown-grace:${group}`),
            },
            {
                what: 'legacy group data',
                run: () => this.client.kv.del({ key: `${this.groupsPrefix}${group}/`, recurse: true }),
            },
        ];
        const results = await Promise.allSettled(dataDeletes.map((d) => d.run()));
        const failed: string[] = [];
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                failed.push(dataDeletes[i].what);
                ctx.logger.error(
                    `Failed to delete ${dataDeletes[i].what} for instance group from consul: ${r.reason}`,
                    {
                        group,
                        err: r.reason,
                    },
                );
            }
        });
        if (failed.length > 0) {
            // The definition is intentionally left in place so the API caller can retry the delete.
            throw new Error(`Failed to delete instance group ${group} from consul: ${failed.join(', ')} not deleted`);
        }
        try {
            await this.delete(`${this.groupsPrefix}${group}`);
        } catch (err) {
            // Propagate like RedisStore.deleteInstanceGroup: a partial delete must not read as success.
            ctx.logger.error(`Failed to delete instance group definition from consul: ${err}`, { group, err });
            throw err;
        }
    }

    // Raw (untrimmed) states under the group's states subtree; keys with empty or malformed values are
    // skipped (see parseItemValue) so one bad key cannot take the whole group down.
    private async fetchRawInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        const items = await this.fetchRecursive(ctx, `${this.groupDataPrefix}${group}/states`);
        const states: InstanceState[] = [];
        for (const item of items) {
            const state = this.parseItemValue<InstanceState>(ctx, item, 'instance state');
            if (state) {
                states.push(state);
            }
        }
        return states;
    }

    async fetchInstanceStates(ctx: Context, group: string): Promise<InstanceState[]> {
        try {
            const rawStates = await this.fetchRawInstanceStates(ctx, group);
            // Skip the recursive shutdown-status fetch for idle/empty groups. This does not leak expired
            // shutdown-status keys: trimCurrent(filterShutdown=true) — the default on the autoscaler/launcher/
            // metrics paths — goes through fetchInstanceStatesWithShutdownStatuses, whose clean read of the
            // shutdown subtree runs every cycle regardless of instance count and reaps them.
            if (rawStates.length === 0) {
                return [];
            }
            const shutdownStatuses = await this.getShutdownStatuses(
                ctx,
                group,
                rawStates.map((state) => state.instanceId),
            );
            return this.trimExpiredStates(ctx, group, rawStates, shutdownStatuses);
        } catch (err) {
            ctx.logger.error(`Failed to get instance states from consul: ${err}`, { err });
            throw err;
        }
    }

    // Single-round-trip variant used by InstanceTracker.trimCurrent. The recursive shutdown-status GET is
    // a whole-group read independent of the instance ids, so one fetch serves both the expiry partition
    // and the tracker's shutting-down filter (it used to run twice per trimCurrent). The shutdown map is
    // always read (even for an empty group) because that clean read is what reaps expired shutdown keys.
    async fetchInstanceStatesWithShutdownStatuses(
        ctx: Context,
        group: string,
    ): Promise<{ states: InstanceState[]; shutdownStatuses: boolean[] }> {
        try {
            const rawStates = await this.fetchRawInstanceStates(ctx, group);
            const shutdownIds = new Set(Object.keys(await this.fetchShutdownStatus(ctx, group)));
            const states = await this.trimExpiredStates(
                ctx,
                group,
                rawStates,
                rawStates.map((state) => shutdownIds.has(state.instanceId)),
            );
            return { states, shutdownStatuses: states.map((state) => shutdownIds.has(state.instanceId)) };
        } catch (err) {
            ctx.logger.error(`Failed to get instance states from consul: ${err}`, { err });
            throw err;
        }
    }

    // Uses the shared expiry policy (see instance_state_expiry.ts) so Consul and Redis stay in lockstep,
    // then deletes the expired state keys from Consul. `shutdownStatuses` is index-aligned with `states`.
    private async trimExpiredStates(
        ctx: Context,
        group: string,
        states: InstanceState[],
        shutdownStatuses: boolean[],
    ): Promise<InstanceState[]> {
        if (states.length === 0) {
            return [];
        }
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
        await this.write(ctx, `${this.groupDataPrefix}${group}/states/${state.instanceId}`, JSON.stringify(state));
        return true;
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
        // Always query with a trailing slash so a prefix of `.../g` cannot also match `.../g-2/...`;
        // callers may pass the key with or without the slash. Short keys are relative to that prefix.
        const prefix = key.endsWith('/') ? key : `${key}/`;
        // Track the full Consul path and ModifyIndex per short key so expired entries are deleted by their
        // real key (not the stripped instance id, which is a no-op) and only via a CAS that fails if the
        // value changed since we read it.
        const meta: { [shortKey: string]: { fullKey: string; modifyIndex: number } } = {};
        (await this.fetchRecursive(ctx, prefix)).map((v) => {
            const ttlValue = this.parseItemValue<TTLValue>(ctx, v, 'TTL value');
            if (!ttlValue) {
                return;
            }
            const shortKey = v.Key.startsWith(prefix) ? v.Key.slice(prefix.length) : v.Key;
            values[shortKey] = ttlValue;
            meta[shortKey] = { fullKey: v.Key, modifyIndex: v.ModifyIndex };
        });
        if (clean) {
            const p: Promise<boolean>[] = [];
            const now = Date.now();
            Object.entries(values).map(([k, v]) => {
                if (isTTLValueExpired(v, now)) {
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
            if (!isTTLValueExpired(ttlv, Date.now())) {
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

    // Writes fail closed: any transport error is logged and rethrown, and a falsy kv.set result (Consul
    // declined the write) throws too. Callers must never see a swallowed write failure as success.
    async write(ctx: Context, key: string, value: string): Promise<boolean> {
        let res: boolean;
        try {
            res = await this.client.kv.set(key, value);
        } catch (err) {
            ctx.logger.error(`Failed to write to consul: ${err}`, { key, err });
            throw err;
        }
        if (!res) {
            ctx.logger.error(`Failed to write to consul`, { key });
            throw new Error(`Failed to write to consul key ${key}`);
        }
        return true;
    }

    // The TTL must be a finite number of seconds >= 0. A non-finite ttl (undefined/NaN, e.g. a group created
    // without protectedTTLSec) would serialize `expires` as null, which isTTLValueExpired reads as
    // never-expires — permanent scale-down protection. Redis throws on `EX undefined`; throwing here keeps
    // the two stores in parity. Use writePersistentValue for values that intentionally never expire.
    async writeTTLValue(ctx: Context, key: string, status: string, ttl: number): Promise<boolean> {
        if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) {
            throw new Error(`Invalid TTL ${ttl} for consul key ${key}: must be a finite number of seconds >= 0`);
        }
        return this.write(ctx, key, JSON.stringify(<TTLValue>{ status, expires: Date.now() + ttl * 1000 }));
    }

    // Writes a TTLValue that never expires client-side (see isTTLValueExpired).
    async writePersistentValue(ctx: Context, key: string, status: string): Promise<boolean> {
        return this.write(ctx, key, JSON.stringify(<TTLValue>{ status, expires: NEVER_EXPIRES }));
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
        await this.write(ctx, `${this.groupDataPrefix}${group}/instances`, JSON.stringify(instances));
        return true;
    }

    async fetchCloudInstances(ctx: Context, group: string): Promise<CloudInstance[]> {
        const item = await this.fetch(ctx, `${this.groupDataPrefix}${group}/instances`);
        if (item && item.Value) {
            return <CloudInstance[]>JSON.parse(item.Value);
        }
        return [];
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

    // Health probe: must resolve a real boolean. Returning the caught Error (truthy) would make the deep
    // health check report a broken Consul as healthy.
    async ping(ctx: Context): Promise<boolean> {
        try {
            await this.client.status.leader();
            return true;
        } catch (err) {
            ctx.logger.error(`Failed to ping consul: ${err}`, { err });
            return false;
        }
    }

    // One-off, idempotent migration for the C2 key-tree move: per-group data used to be nested under the
    // group definitions prefix (`${groupsPrefix}<group>/states/<id>`, ...) and now lives under
    // groupDataPrefix. Every nested key under groupsPrefix is copied to the same suffix under
    // groupDataPrefix unless a value already exists there (the new layout wins), then the legacy key is
    // deleted. A clean tree is a no-op. Safe to run on every startup.
    async migrateLegacyGroupData(ctx: Context): Promise<LegacyGroupDataMigrationSummary> {
        const summary: LegacyGroupDataMigrationSummary = { moved: 0, skipped: 0, deleted: 0 };
        const items = await this.fetchRecursive(ctx, this.groupsPrefix);
        for (const item of items) {
            if (!item.Key.startsWith(this.groupsPrefix)) {
                continue;
            }
            const suffix = item.Key.slice(this.groupsPrefix.length);
            if (!suffix.includes('/')) {
                // a bare `${groupsPrefix}<name>` key is a group definition, which stays where it is
                continue;
            }
            const target = `${this.groupDataPrefix}${suffix}`;
            const existing = await this.fetch(ctx, target);
            if (existing) {
                ctx.logger.debug('legacy group data key not moved, target already exists', { key: item.Key, target });
                summary.skipped++;
            } else if (!item.Value) {
                ctx.logger.debug('legacy group data key has no value, not moved', { key: item.Key });
                summary.skipped++;
            } else {
                await this.write(ctx, target, item.Value);
                summary.moved++;
            }
            await this.delete(item.Key);
            summary.deleted++;
        }
        ctx.logger.info('Legacy consul group data migration finished', {
            ...summary,
            groupsPrefix: this.groupsPrefix,
            groupDataPrefix: this.groupDataPrefix,
        });
        return summary;
    }

    // Reservation store methods

    private reservationKey(groupName: string, id: string): string {
        return `${this.reservationsPrefix}${groupName}/${id}`;
    }

    // The reservation itself is JSON nested inside the TTLValue's status string; a malformed inner value is
    // skipped (with a warning) rather than failing the lookup.
    private parseReservation(ctx: Context, key: string, ttlValue: TTLValue): Reservation | undefined {
        try {
            const reservation = JSON.parse(ttlValue.status);
            if (reservation === null || typeof reservation !== 'object') {
                ctx.logger.warn('Skipping reservation with a non-object JSON value in consul', { key });
                return undefined;
            }
            return <Reservation>reservation;
        } catch (err) {
            ctx.logger.warn(`Skipping reservation with malformed JSON in consul: ${err}`, { key, err });
            return undefined;
        }
    }

    async saveReservation(ctx: Context, reservation: Reservation): Promise<void> {
        const key = this.reservationKey(reservation.groupName, reservation.id);
        const value = JSON.stringify(reservation);
        if (isTerminalReservationStatus(reservation.status)) {
            // Terminal: retain briefly so the final status stays readable, then let the clean path drop it.
            const ttl = terminalReservationTTLSec(reservation, this.terminalReservationRetentionSec);
            await this.writeTTLValue(ctx, key, value, ttl);
        } else {
            // Non-terminal: never expires at the store level. Expiry is a status transition owned by
            // ReservationManager (which sets the scale-down grace); a held ("take and hold") reservation
            // is never re-saved and must not be evicted by a store TTL.
            await this.writePersistentValue(ctx, key, value);
        }
    }

    async getReservation(ctx: Context, id: string): Promise<Reservation | null> {
        // Since we don't know the group name, search all reservations
        const items = await this.fetchRecursive(ctx, this.reservationsPrefix);
        for (const item of items) {
            if (!item.Key.endsWith(`/${id}`)) {
                continue;
            }
            const ttlValue = this.parseItemValue<TTLValue>(ctx, item, 'reservation');
            if (!ttlValue) {
                continue;
            }
            if (!isTTLValueExpired(ttlValue, Date.now())) {
                return this.parseReservation(ctx, item.Key, ttlValue) ?? null;
            }
            // Expired reservation: clean it up (by its full key) rather than leaving it in the KV. CAS-guarded
            // like fetchRecursiveTTLValues so a concurrent re-save between our read and this delete (which
            // bumps the ModifyIndex) is never clobbered; the next read picks up the refreshed value.
            try {
                const deleted = await this.deleteCas(item.Key, item.ModifyIndex);
                if (!deleted) {
                    ctx.logger.debug('expired reservation was rewritten concurrently, not deleted', {
                        id,
                        key: item.Key,
                    });
                }
            } catch (err) {
                ctx.logger.error(`Failed to delete expired reservation from consul`, { id, key: item.Key, err });
            }
            return null;
        }
        return null;
    }

    async listReservations(ctx: Context, groupName: string): Promise<Reservation[]> {
        // Trailing slash: the prefix `.../jvb-east` would otherwise also match `.../jvb-east-2/<id>`.
        const key = `${this.reservationsPrefix}${groupName}/`;
        const ttlValues = await this.fetchRecursiveTTLValues(ctx, key, true);
        const reservations: Reservation[] = [];
        for (const [shortKey, ttlValue] of Object.entries(ttlValues)) {
            const reservation = this.parseReservation(ctx, `${key}${shortKey}`, ttlValue);
            if (reservation) {
                reservations.push(reservation);
            }
        }
        return reservations;
    }

    async deleteReservation(ctx: Context, id: string, groupName: string): Promise<void> {
        try {
            await this.delete(this.reservationKey(groupName, id));
        } catch (err) {
            // Propagate like RedisStore.deleteReservation; a swallowed failure would report a delete that
            // never happened.
            ctx.logger.error(`Failed to delete reservation from consul`, { id, groupName, err });
            throw err;
        }
    }

    async setScaleDownGrace(ctx: Context, groupName: string, ttlSec: number): Promise<void> {
        await this.setValue(ctx, `reservation-scaledown-grace:${groupName}`, 'active', ttlSec);
    }

    async isScaleDownGraceActive(ctx: Context, groupName: string): Promise<boolean> {
        return this.checkValue(ctx, `reservation-scaledown-grace:${groupName}`);
    }
}
