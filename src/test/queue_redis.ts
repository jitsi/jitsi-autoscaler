/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import test, { afterEach, describe, mock } from 'node:test';
import { RedisClient } from 'redis';
import { isClient } from 'bee-queue/lib/redis';
import { reconnectQueueClientOnReadonly } from '../queue_redis';

// Mirrors the redis 3 RedisClient members that the hook uses.
class FakeRedisClient extends EventEmitter {
    constructor() {
        super();
        this.stream = { destroy: mock.fn() };
        this.delivered = [];
        this.copies = [];
    }
    return_error(err) {
        err.command = 'SET';
        this.delivered.push(err);
    }
    duplicate() {
        const copy = new FakeRedisClient();
        this.copies.push(copy);
        return copy;
    }
}

describe('reconnectQueueClientOnReadonly', () => {
    afterEach(() => mock.timers.reset());

    const readonlyErr = new Error("READONLY You can't write against a read only replica.");

    function makeClient() {
        const logger = { warn: mock.fn() };
        const client = reconnectQueueClientOnReadonly(new FakeRedisClient(), logger, 'job queue');
        return { logger, client };
    }

    test('destroys the socket and still delivers the error on a READONLY reply', () => {
        const { logger, client } = makeClient();
        client.return_error(readonlyErr);

        assert.equal(client.stream.destroy.mock.callCount(), 1);
        assert.deepEqual(client.delivered, [readonlyErr]);
        assert.equal(logger.warn.mock.callCount(), 1);
    });

    test('warns at most once a minute and names the command', () => {
        mock.timers.enable({ apis: ['Date'], now: Date.now() });
        const { logger, client } = makeClient();
        client.return_error(readonlyErr);
        client.emit('ready');
        mock.timers.tick(59_000);
        client.return_error(readonlyErr);
        assert.equal(client.stream.destroy.mock.callCount(), 2);
        assert.equal(logger.warn.mock.callCount(), 1);
        assert.match(logger.warn.mock.calls[0].arguments[0], /READONLY reply to SET on the job queue client/);

        mock.timers.tick(1_000);
        client.return_error(readonlyErr);
        assert.equal(logger.warn.mock.callCount(), 2);
    });

    test('leaves the socket open on other errors', () => {
        const { logger, client } = makeClient();
        const err = new Error('ERR wrong number of arguments');
        client.return_error(err);

        assert.equal(client.stream.destroy.mock.callCount(), 0);
        assert.deepEqual(client.delivered, [err]);
        assert.equal(logger.warn.mock.callCount(), 0);
    });

    test('hooks each duplicate with its own warn flag', () => {
        const { logger, client } = makeClient();
        const copy = client.duplicate();
        assert.equal(client.copies[0], copy);

        client.return_error(readonlyErr);
        copy.return_error(readonlyErr);
        assert.equal(copy.stream.destroy.mock.callCount(), 1);
        assert.equal(logger.warn.mock.callCount(), 2);

        copy.duplicate().return_error(readonlyErr);
        assert.equal(logger.warn.mock.callCount(), 3);
    });

    // Fails if redis 3 renames return_error or its parser stops calling it through the instance.
    for (const [label, reply] of [
        ['a plain', "-READONLY You can't write against a read only replica.\r\n"],
        [
            'a Redis 6 script',
            '-ERR Error running script (call to f_x): @user_script:1: @user_script: 1: ' +
                "-READONLY You can't write against a read only replica.\r\n",
        ],
    ]) {
        test(`reconnects a real redis 3 client on ${label} READONLY reply`, async () => {
            const stream = new Duplex({
                read() {},
                write(_chunk, _encoding, done) {
                    done();
                },
            });
            stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => stream;
            stream.destroy = mock.fn();
            stream.destroySoon = () => {};
            const logger = { warn: mock.fn() };
            const client = reconnectQueueClientOnReadonly(
                new RedisClient({ no_ready_check: true }, stream),
                logger,
                'job queue',
            );
            assert.ok(isClient(client));

            stream.emit('connect');
            const result = new Promise((resolve) => client.set('k', 'v', resolve));
            stream.emit('data', Buffer.from(reply));
            const err = await result;

            assert.match(err.message, /READONLY/);
            assert.equal(err.command, 'SET');
            assert.equal(stream.destroy.mock.callCount(), 1);
            assert.equal(logger.warn.mock.callCount(), 1);
            client.end(false);
        });
    }
});
