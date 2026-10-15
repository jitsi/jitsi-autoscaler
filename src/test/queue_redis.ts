/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import test, { describe, mock } from 'node:test';
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
        this.delivered.push(err);
    }
    duplicate() {
        const copy = new FakeRedisClient();
        this.copies.push(copy);
        return copy;
    }
}

describe('reconnectQueueClientOnReadonly', () => {
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

    test('warns once per connection', () => {
        const { logger, client } = makeClient();
        client.return_error(readonlyErr);
        client.return_error(readonlyErr);
        assert.equal(client.stream.destroy.mock.callCount(), 2);
        assert.equal(logger.warn.mock.callCount(), 1);

        client.emit('ready');
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
});
