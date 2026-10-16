/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Duplex } from 'node:stream';
import test, { afterEach, describe, mock } from 'node:test';
import { createClient, RedisClient } from 'redis';
import { isClient } from 'bee-queue/lib/redis';
import { buildCache, shas } from 'bee-queue/lib/lua';
import { reconnectQueueClientOnReadonly, reloadQueueScriptsOnReady } from '../queue_redis';

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

    // The tests above stub stream.destroy(), so only this one shows that redis 3 really reconnects and that the
    // script reload runs again on the new connection.
    test('a real redis 3 client reconnects to a fake replica and reloads the scripts', async () => {
        const commands = [];
        const server = net.createServer((socket) => {
            const connection = commands.push([]) - 1;
            socket.on('data', (data) => {
                const lines = data.toString().split('\r\n');
                for (let i = 0; i < lines.length; i++) {
                    if (!lines[i].startsWith('*')) continue;
                    const args = [];
                    for (let n = Number(lines[i].slice(1)); n > 0; n--) {
                        args.push(lines[i + 2]);
                        i += 2;
                    }
                    const name = args[0].toUpperCase();
                    commands[connection].push(name);
                    if (name === 'SET') {
                        socket.write("-READONLY You can't write against a read only replica.\r\n");
                    } else if (name === 'SCRIPT') {
                        socket.write(`*${args.length - 2}\r\n` + ':1\r\n'.repeat(args.length - 2));
                    } else {
                        socket.write('+OK\r\n');
                    }
                }
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const logger = { warn: mock.fn(), error: mock.fn() };
        const client = reloadQueueScriptsOnReady(
            reconnectQueueClientOnReadonly(
                createClient({ host: '127.0.0.1', port: server.address().port, no_ready_check: true }),
                logger,
                'job queue',
            ),
            logger,
            'job queue',
        );
        client.on('error', () => undefined);
        const waitForScript = async (connection) => {
            for (let i = 0; i < 200 && !commands[connection]?.includes('SCRIPT'); i++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(commands[connection]?.includes('SCRIPT'), `expect a script reload on connection ${connection}`);
        };
        try {
            await waitForScript(0);
            const err = await new Promise((resolve) => client.set('k', 'v', resolve));
            assert.match(err.message, /READONLY/);
            await waitForScript(1);
            assert.equal(logger.warn.mock.callCount(), 1);
        } finally {
            client.end(false);
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('reloadQueueScriptsOnReady', () => {
    async function waitFor(check) {
        for (let i = 0; i < 100 && !check(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(check());
    }

    function makeClient(scriptReply) {
        const client = new FakeRedisClient();
        client.script = mock.fn(scriptReply);
        const logger = { error: mock.fn() };
        reloadQueueScriptsOnReady(client, logger, 'job queue');
        return { client, logger };
    }

    test('loads only the missing scripts on each ready', async () => {
        // shas fills in only after Bee-Queue first reads its script files.
        await buildCache({ script: (_op, _arg, done) => done(null, [1]) });
        assert.ok(Object.keys(shas).length > 1);
        const present = Object.values(shas)[0];
        const { client } = makeClient((op, arg, done) =>
            done(null, op === 'exists' ? [arg === present ? 1 : 0] : 'sha'),
        );
        const loads = () => client.script.mock.calls.filter((c) => c.arguments[0] === 'load').length;
        const scriptCount = Object.keys(shas).length;

        client.emit('ready');
        await waitFor(() => loads() === scriptCount - 1);
        client.emit('ready');
        await waitFor(() => loads() === 2 * (scriptCount - 1));
    });

    test('logs a failed reload', async () => {
        const { client, logger } = makeClient((_op, _arg, done) => done(new Error('ERR boom')));
        client.emit('ready');
        await waitFor(() => logger.error.mock.callCount() === 1);
        assert.match(
            logger.error.mock.calls[0].arguments[0],
            /Failed to reload the Bee-Queue scripts on the job queue/,
        );
    });
});
