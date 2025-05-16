/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A comprehensive in-memory mock Redis client for testing
 * This implementation simulates Redis behavior for keys, hashes, sorted sets, etc.
 */

export class MockRedisClient {
    private data: Map<string, string> = new Map();
    private hashes: Map<string, Map<string, string>> = new Map();
    private sets: Map<string, Set<string>> = new Map();
    private sortedSets: Map<string, Map<string, number>> = new Map();
    private ttls: Map<string, number> = new Map();

    // Basic key operations
    async get(key: string): Promise<string | null> {
        this.checkTTL(key);
        return this.data.get(key) || null;
    }

    async set(key: string, value: string, expiryMode?: string, time?: number): Promise<string> {
        this.data.set(key, value);
        if (expiryMode === 'EX' && time) {
            this.ttls.set(key, Date.now() + time * 1000);
        }
        return 'OK';
    }

    async del(key: string): Promise<number> {
        let count = 0;
        if (this.data.has(key)) {
            this.data.delete(key);
            this.ttls.delete(key);
            count++;
        }
        if (this.hashes.has(key)) {
            this.hashes.delete(key);
            count++;
        }
        if (this.sets.has(key)) {
            this.sets.delete(key);
            count++;
        }
        if (this.sortedSets.has(key)) {
            this.sortedSets.delete(key);
            count++;
        }
        return count;
    }

    async expire(key: string, seconds: number): Promise<number> {
        if (this.data.has(key) || this.hashes.has(key) || this.sets.has(key) || this.sortedSets.has(key)) {
            this.ttls.set(key, Date.now() + seconds * 1000);
            return 1;
        }
        return 0;
    }

    // Hash operations
    async hset(hash: string, field: string, value: string): Promise<number> {
        if (!this.hashes.has(hash)) {
            this.hashes.set(hash, new Map());
        }
        const isNew = !this.hashes.get(hash)!.has(field);
        this.hashes.get(hash)!.set(field, value);
        return isNew ? 1 : 0;
    }

    async hget(hash: string, field: string): Promise<string | null> {
        this.checkTTL(hash);
        if (!this.hashes.has(hash)) {
            return null;
        }
        return this.hashes.get(hash)!.get(field) || null;
    }

    async hgetall(hash: string): Promise<Record<string, string> | null> {
        this.checkTTL(hash);
        if (!this.hashes.has(hash)) {
            return null;
        }

        const result: Record<string, string> = {};
        for (const [field, value] of this.hashes.get(hash)!.entries()) {
            result[field] = value;
        }
        return result;
    }

    async hdel(hash: string, field: string): Promise<number> {
        if (!this.hashes.has(hash)) {
            return 0;
        }
        const deleted = this.hashes.get(hash)!.delete(field);
        return deleted ? 1 : 0;
    }

    async hkeys(hash: string): Promise<string[]> {
        this.checkTTL(hash);
        if (!this.hashes.has(hash)) {
            return [];
        }
        return Array.from(this.hashes.get(hash)!.keys());
    }

    async hscan(
        hash: string,
        cursor: string,
        matchArg?: string,
        pattern?: string,
        countArg?: string,
        count?: number,
    ): Promise<[string, string[]]> {
        this.checkTTL(hash);

        // Handle MATCH and COUNT arguments - Redis hscan allows for these as separate arguments
        if (matchArg === 'MATCH' && pattern && countArg === 'COUNT' && count) {
            return this.doHscan(hash, cursor, pattern, count);
        } else if (matchArg === 'MATCH' && pattern) {
            return this.doHscan(hash, cursor, pattern);
        } else if (countArg === 'COUNT' && count) {
            return this.doHscan(hash, cursor, '*', count);
        }

        return this.doHscan(hash, cursor);
    }

    private doHscan(
        hash: string,
        cursor: string,
        pattern: string = '*',
        _count: number = 10,
    ): Promise<[string, string[]]> {
        if (!this.hashes.has(hash) || this.hashes.get(hash)!.size === 0) {
            return Promise.resolve(['0', []]);
        }

        // For simplicity, we'll just return all fields and values at once
        // In a real implementation, we would respect cursor and count
        const keys = Array.from(this.hashes.get(hash)!.keys());

        // Filter keys by pattern if it's not a wildcard
        const filteredKeys =
            pattern === '*'
                ? keys
                : keys.filter((key) => {
                      if (pattern.endsWith('*')) {
                          const prefix = pattern.slice(0, -1);
                          return key.startsWith(prefix);
                      }
                      return key === pattern;
                  });

        // Flatten to [key1, value1, key2, value2, ...] format that Redis uses
        const values = filteredKeys.flatMap((key) => [key, this.hashes.get(hash)!.get(key)]);

        return Promise.resolve(['0', values.filter((v) => v !== undefined)]); // Return cursor '0' to indicate completion
    }

    // Sorted set operations
    async zadd(key: string, score: number, member: string): Promise<number> {
        if (!this.sortedSets.has(key)) {
            this.sortedSets.set(key, new Map());
        }
        const isNew = !this.sortedSets.get(key)!.has(member);
        this.sortedSets.get(key)!.set(member, score);
        return isNew ? 1 : 0;
    }

    async zrange(key: string, start: number, stop: number): Promise<string[]> {
        this.checkTTL(key);
        if (!this.sortedSets.has(key)) {
            return [];
        }

        // Sort by score and return the members in the specified range
        const entries = Array.from(this.sortedSets.get(key)!.entries()).sort((a, b) => a[1] - b[1]);

        // Handle negative indices and slice according to Redis behavior
        const actualStart = start < 0 ? entries.length + start : start;
        const actualStop = stop < 0 ? entries.length + stop : stop;

        return entries.slice(actualStart, actualStop + 1).map((entry) => entry[0]);
    }

    async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
        this.checkTTL(key);
        if (!this.sortedSets.has(key)) {
            return 0;
        }

        const minScore = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
        const maxScore = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);

        let count = 0;
        const members = Array.from(this.sortedSets.get(key)!.entries());
        for (const [member, score] of members) {
            if (score >= minScore && score <= maxScore) {
                this.sortedSets.get(key)!.delete(member);
                count++;
            }
        }

        return count;
    }

    // Keys operations
    async keys(pattern: string): Promise<string[]> {
        // Simple glob pattern matching
        const allKeys = [
            ...Array.from(this.data.keys()),
            ...Array.from(this.hashes.keys()),
            ...Array.from(this.sets.keys()),
            ...Array.from(this.sortedSets.keys()),
        ];

        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            return allKeys.filter((key) => key.startsWith(prefix));
        }

        return allKeys.filter((key) => key === pattern);
    }

    async scan(
        cursor: string,
        matchArg?: string,
        pattern?: string,
        countArg?: string,
        count?: number,
    ): Promise<[string, string[]]> {
        // Handle MATCH and COUNT arguments - Redis scan allows for these as separate arguments
        if (matchArg === 'MATCH' && pattern && countArg === 'COUNT' && count) {
            return this.doScan(cursor, pattern, count);
        } else if (matchArg === 'MATCH' && pattern) {
            return this.doScan(cursor, pattern);
        } else if (countArg === 'COUNT' && count) {
            return this.doScan(cursor, '*', count);
        }

        return this.doScan(cursor);
    }

    private async doScan(cursor: string, pattern: string = '*', _count: number = 10): Promise<[string, string[]]> {
        // For simplicity in testing, we'll just return all keys at once
        // ignoring cursor and count
        const keys = await this.keys(pattern);
        return ['0', keys]; // Return cursor '0' to indicate completion
    }

    // Pipeline implementation
    pipeline(): MockRedisPipeline {
        return new MockRedisPipeline(this);
    }

    // Helper for checking TTL expiry
    private checkTTL(key: string): void {
        if (this.ttls && this.ttls.has(key) && this.ttls.get(key)! < Date.now()) {
            this.data.delete(key);
            this.hashes.delete(key);
            this.sets.delete(key);
            this.sortedSets.delete(key);
            this.ttls.delete(key);
        }
    }

    // Used for testing - simulate ping callback
    ping(callback: (err: Error | null, reply: string) => void): void {
        callback(null, 'PONG');
    }

    // Clear all data - useful for tests setup/teardown
    clearAll(): void {
        this.data.clear();
        this.hashes.clear();
        this.sets.clear();
        this.sortedSets.clear();
        this.ttls.clear();
    }
}

// Mock Redis Pipeline Implementation
export class MockRedisPipeline {
    private commands: Array<{
        command: string;
        args: any[];
        resolve: (result: any) => void;
        reject: (error: Error) => void;
    }> = [];

    private redisClient: MockRedisClient;

    constructor(redisClient: MockRedisClient) {
        this.redisClient = redisClient;
    }

    // Key operations
    get(key: string) {
        return this.addCommand('get', [key]);
    }

    set(key: string, value: string, expiryMode?: string, time?: number) {
        return this.addCommand('set', [key, value, expiryMode, time]);
    }

    // Hash operations
    hget(hash: string, field: string) {
        return this.addCommand('hget', [hash, field]);
    }

    hset(hash: string, field: string, value: string) {
        return this.addCommand('hset', [hash, field, value]);
    }

    hdel(hash: string, field: string) {
        return this.addCommand('hdel', [hash, field]);
    }

    // Execute all commands in the pipeline
    async exec(): Promise<Array<[Error | null, any]>> {
        const results: Array<[Error | null, any]> = [];

        for (const cmd of this.commands) {
            try {
                let result;
                switch (cmd.command) {
                    case 'get':
                        result = await this.redisClient.get(cmd.args[0]);
                        break;
                    case 'set':
                        result = await this.redisClient.set(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3]);
                        break;
                    case 'hget':
                        result = await this.redisClient.hget(cmd.args[0], cmd.args[1]);
                        break;
                    case 'hset':
                        result = await this.redisClient.hset(cmd.args[0], cmd.args[1], cmd.args[2]);
                        break;
                    case 'hdel':
                        result = await this.redisClient.hdel(cmd.args[0], cmd.args[1]);
                        break;
                    default:
                        throw new Error(`Unsupported command: ${cmd.command}`);
                }
                results.push([null, result]);
                cmd.resolve(result);
            } catch (error) {
                results.push([error as Error, null]);
                cmd.reject(error as Error);
            }
        }

        // Clear commands after execution
        this.commands = [];

        return results;
    }

    private addCommand(command: string, args: any[]) {
        return new Promise<any>((resolve, reject) => {
            this.commands.push({ command, args, resolve, reject });
        });
    }
}
