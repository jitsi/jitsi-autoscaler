import { ClientOpts, RedisClient } from 'redis';
import { Logger } from 'winston';
import { reconnectOnReadonly } from './redis';

interface RedisClientInternals {
    return_error(err: Error): void;
    stream: { destroy(): void };
}

// redis 3 has no reconnectOnError, so this wraps its internal reply-error handler. On READONLY it destroys the
// socket, and redis 3 reconnects. Every in-flight write on a replica connection replies READONLY, so each client
// warns once per connection. duplicate() is wrapped because Bee-Queue makes its blocking and event clients with it.
export function reconnectQueueClientOnReadonly(client: RedisClient, logger: Logger, name: string): RedisClient {
    const internals = client as unknown as RedisClientInternals;
    const returnError = internals.return_error;
    let readonlyWarned = false;

    internals.return_error = (err: Error) => {
        if (reconnectOnReadonly(err)) {
            if (!readonlyWarned) {
                readonlyWarned = true;
                logger.warn(`[Redis] READONLY reply on the ${name} client, reconnecting to find the primary`, { err });
            }
            internals.stream.destroy();
        }
        returnError.call(client, err);
    };
    client.on('ready', () => {
        readonlyWarned = false;
    });

    const duplicate = client.duplicate;
    // With a callback, redis 3 duplicate() returns nothing; Bee-Queue calls it without one.
    client.duplicate = (options?: ClientOpts) =>
        reconnectQueueClientOnReadonly(duplicate.call(client, options), logger, name);

    return client;
}
