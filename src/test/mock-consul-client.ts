/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A minimal in-memory mock of the `consul` client's KV API, covering the subset used by ConsulStore:
 *   kv.get(key)                      -> single GetItem | undefined
 *   kv.get({ key, recurse: true })   -> GetItem[] | undefined (prefix match)
 *   kv.set(key, value)               -> boolean
 *   kv.set({ key, value, ... })      -> boolean (lock acquire/release path)
 *   kv.del(key)                      -> boolean
 *   kv.del({ key, recurse: true })   -> boolean (prefix delete)
 */

interface GetItem {
    Key: string;
    Value: string;
    ModifyIndex: number;
}

export class MockConsulClient {
    private store: Map<string, string> = new Map();
    // Per-key ModifyIndex, bumped on every write, so CAS deletes can be exercised.
    private modifyIndex: Map<string, number> = new Map();
    private indexCounter = 0;

    private writeKey(key: string, value: string): void {
        this.store.set(key, value);
        this.modifyIndex.set(key, ++this.indexCounter);
    }

    private deleteKey(key: string): void {
        this.store.delete(key);
        this.modifyIndex.delete(key);
    }

    private item(key: string): GetItem {
        return { Key: key, Value: this.store.get(key)!, ModifyIndex: this.modifyIndex.get(key)! };
    }

    kv = {
        get: async (arg: string | { key: string; recurse?: boolean }): Promise<GetItem | GetItem[] | undefined> => {
            if (typeof arg === 'string') {
                return this.store.has(arg) ? this.item(arg) : undefined;
            }
            const { key, recurse } = arg;
            if (recurse) {
                const items: GetItem[] = [];
                for (const k of this.store.keys()) {
                    if (k === key || k.startsWith(key)) {
                        items.push(this.item(k));
                    }
                }
                return items.length > 0 ? items : undefined;
            }
            return this.store.has(key) ? this.item(key) : undefined;
        },

        set: async (arg: string | { key: string; value: string }, value?: string): Promise<boolean> => {
            if (typeof arg === 'string') {
                this.writeKey(arg, value!);
                return true;
            }
            this.writeKey(arg.key, arg.value);
            return true;
        },

        del: async (arg: string | { key: string; recurse?: boolean; cas?: number }): Promise<boolean> => {
            if (typeof arg === 'string') {
                this.deleteKey(arg);
                return true;
            }
            const { key, recurse, cas } = arg;
            if (recurse) {
                for (const k of Array.from(this.store.keys())) {
                    if (k === key || k.startsWith(key)) {
                        this.deleteKey(k);
                    }
                }
                return true;
            }
            // CAS delete: only remove the key if its ModifyIndex matches the supplied cas value.
            if (cas !== undefined) {
                if (this.modifyIndex.get(key) !== cas) {
                    return false;
                }
            }
            this.deleteKey(key);
            return true;
        },
    };

    status = {
        leader: async (): Promise<string> => 'leader',
    };

    // test helpers
    keys(): string[] {
        return Array.from(this.store.keys());
    }

    clearAll(): void {
        this.store.clear();
    }
}
