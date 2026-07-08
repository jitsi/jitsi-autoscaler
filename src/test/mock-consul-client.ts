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
}

export class MockConsulClient {
    private store: Map<string, string> = new Map();

    kv = {
        get: async (arg: string | { key: string; recurse?: boolean }): Promise<GetItem | GetItem[] | undefined> => {
            if (typeof arg === 'string') {
                if (!this.store.has(arg)) {
                    return undefined;
                }
                return { Key: arg, Value: this.store.get(arg)! };
            }
            const { key, recurse } = arg;
            if (recurse) {
                const items: GetItem[] = [];
                for (const [k, v] of this.store.entries()) {
                    if (k === key || k.startsWith(key)) {
                        items.push({ Key: k, Value: v });
                    }
                }
                return items.length > 0 ? items : undefined;
            }
            if (!this.store.has(key)) {
                return undefined;
            }
            return { Key: key, Value: this.store.get(key)! };
        },

        set: async (arg: string | { key: string; value: string }, value?: string): Promise<boolean> => {
            if (typeof arg === 'string') {
                this.store.set(arg, value!);
                return true;
            }
            this.store.set(arg.key, arg.value);
            return true;
        },

        del: async (arg: string | { key: string; recurse?: boolean }): Promise<boolean> => {
            if (typeof arg === 'string') {
                this.store.delete(arg);
                return true;
            }
            const { key, recurse } = arg;
            if (recurse) {
                for (const k of Array.from(this.store.keys())) {
                    if (k === key || k.startsWith(key)) {
                        this.store.delete(k);
                    }
                }
                return true;
            }
            this.store.delete(key);
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
