import { ClientOpts, RedisClient } from 'redis';
import { Logger } from 'winston';
import { reconnectOnReadonly } from './redis';

interface RedisClientInternals {
    return_error(err: Error): void;
    stream: { destroy(): void };
}

const READONLY_WARN_INTERVAL_MS = 60_000;

// redis 3 has no reconnectOnError, so this wraps its internal reply-error handler. On READONLY it destroys the
// socket, and redis 3 reconnects. While the host name resolves to a replica, each client reconnects every 200 ms,
// so each client warns at most once a minute. duplicate() is wrapped because Bee-Queue makes its blocking and event
// clients with it.
export function reconnectQueueClientOnReadonly(client: RedisClient, logger: Logger, name: string): RedisClient {
    const internals = client as unknown as RedisClientInternals;
    const returnError = internals.return_error;
    let lastWarnAt = -Infinity;

    internals.return_error = (err: Error & { command?: string }) => {
        const readonly = reconnectOnReadonly(err);
        if (readonly) {
            internals.stream.destroy();
        }
        returnError.call(client, err);
        // After returnError, because it sets err.command, which tells the 3 clients of the queue apart.
        if (readonly && Date.now() - lastWarnAt >= READONLY_WARN_INTERVAL_MS) {
            lastWarnAt = Date.now();
            logger.warn(
                `[Redis] READONLY reply to ${err.command} on the ${name} client, reconnecting to find the primary`,
                { err },
            );
        }
    };

    const duplicate = client.duplicate;
    // With a callback, redis 3 duplicate() returns nothing; Bee-Queue calls it without one.
    client.duplicate = (options?: ClientOpts) =>
        reconnectQueueClientOnReadonly(duplicate.call(client, options), logger, name);

    return client;
}
