/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { after, afterEach, before, describe, mock } from 'node:test';
import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import CustomInstanceManager from '../custom_instance_manager';

function initContext() {
    return {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };
}

// generous default: the first exec of a freshly written script can take a few hundred ms on macOS
const LAUNCH_TIMEOUT_MS = 5000;
// short timeout for the tests that deliberately let the script hang
const HANG_TIMEOUT_MS = 300;
const LIST_SCRIPT_MAX_BUFFER = 16 * 1024 * 1024;

describe('CustomInstanceManager', () => {
    const group = { name: 'grp', type: 'jibri', region: 'us-east', instanceConfigurationId: 'cfg' };
    const messages = (fn) => fn.mock.calls.map((call) => call.arguments[0]);

    let dir;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoscaler-custom-'));
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // write an executable /bin/sh script into the temp dir and return its path
    function writeScript(name, body) {
        const scriptPath = path.join(dir, name);
        fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return scriptPath;
    }

    function buildManager({
        launchScript = path.join(dir, 'missing-launch.sh'),
        listScript = undefined,
        isDryRun = false,
        timeoutMs = LAUNCH_TIMEOUT_MS,
    } = {}) {
        return new CustomInstanceManager({
            isDryRun,
            customConfigurationLaunchScriptPath: launchScript,
            customConfigurationLaunchScriptTimeoutMs: timeoutMs,
            customConfigurationListScriptPath: listScript,
        });
    }

    describe('launchInstances', () => {
        test('records the last stdout line of the launch script as the instance id', async () => {
            const argsFile = path.join(dir, 'launch-args');
            const script = writeScript(
                'launch-ok.sh',
                `printf '%s\\n' "$@" > "${argsFile}"\necho "provisioning, please wait"\necho "i-12345"`,
            );
            const ctx = initContext();

            const result = await buildManager({ launchScript: script }).launchInstances(ctx, group, 0, 1);

            assert.deepEqual(result, ['i-12345']);
            assert.equal(ctx.logger.error.mock.calls.length, 0);
            assert.ok(
                messages(ctx.logger.info).some((m) => m.includes('Got launch response') && m.includes('i-12345')),
                'launch response logged with the instance id',
            );
            // each flag and its value are passed as a single argv element (script contract)
            const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
            assert.equal(args.length, 4);
            assert.equal(args[0], '--type jibri');
            assert.match(args[1], /^--name grp-[A-Za-z0-9]{5}$/);
            assert.equal(args[2], '--groupName grp');
            assert.equal(args[3], '--region us-east');
        });

        test('runs the script once per requested instance', async () => {
            // $$ is the pid of the script's shell, distinct per run
            const script = writeScript('launch-pid.sh', 'echo "i-$$"');

            const result = await buildManager({ launchScript: script }).launchInstances(initContext(), group, 0, 3);

            assert.equal(result.length, 3);
            assert.ok(result.every((id) => /^i-\d+$/.test(id)));
            assert.equal(new Set(result).size, 3, 'three distinct ids');
        });

        test('resolves false with a distinct orphan warning when the script exits 0 without an instance id', async () => {
            const script = writeScript('launch-silent.sh', 'echo "created something" >&2\nexit 0');
            const ctx = initContext();

            const result = await buildManager({ launchScript: script }).launchInstances(ctx, group, 0, 1);

            assert.deepEqual(result, [false]);
            const errors = messages(ctx.logger.error);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /exited 0 but script produced no instance id; a VM may have been created/);
            assert.ok(!errors[0].includes('killed'));
        });

        test('kills a launch script that exceeds the timeout and logs the orphan warning', async () => {
            // exec so that sleep receives the kill signal directly and the stdout pipe closes
            const script = writeScript('launch-hang.sh', 'exec sleep 5');
            const ctx = initContext();
            const started = Date.now();

            const result = await buildManager({ launchScript: script, timeoutMs: HANG_TIMEOUT_MS }).launchInstances(
                ctx,
                group,
                0,
                1,
            );

            assert.deepEqual(result, [false]);
            assert.ok(Date.now() - started < 4000, 'did not wait for the script to finish on its own');
            const killed = messages(ctx.logger.error).filter((m) => m.includes('was killed after'));
            assert.equal(killed.length, 1);
            assert.match(killed[0], new RegExp(`was killed after ${HANG_TIMEOUT_MS}ms \\(signal SIGTERM\\)`));
            assert.match(killed[0], /a VM may have been created but cannot be tracked/);
        });

        test('resolves false when the launch script exits non-zero', async () => {
            const script = writeScript('launch-fail.sh', 'echo "i-should-be-ignored"\necho "boom" >&2\nexit 3');
            const ctx = initContext();

            const result = await buildManager({ launchScript: script }).launchInstances(ctx, group, 0, 1);

            assert.deepEqual(result, [false]);
            const errors = messages(ctx.logger.error);
            assert.ok(errors.some((m) => m.includes('Failed executing launch file')));
            assert.ok(!errors.some((m) => m.includes('was killed')));
        });

        test('resolves false when the launch script does not exist', async () => {
            const ctx = initContext();

            const result = await buildManager({ launchScript: path.join(dir, 'nope.sh') }).launchInstances(
                ctx,
                group,
                0,
                1,
            );

            assert.deepEqual(result, [false]);
            assert.ok(messages(ctx.logger.error).some((m) => m.includes('Failed executing launch file')));
        });

        test('dry run resolves true without running the script', async () => {
            const marker = path.join(dir, 'dry-run-marker');
            const script = writeScript('launch-marker.sh', `touch "${marker}"\necho "i-1"`);

            const result = await buildManager({ launchScript: script, isDryRun: true }).launchInstances(
                initContext(),
                group,
                0,
                2,
            );

            assert.deepEqual(result, [true, true]);
            assert.ok(!fs.existsSync(marker), 'script was not executed');
        });
    });

    describe('getInstances', () => {
        const retryStrategy = {};

        test('parses the JSON array printed by the list script', async () => {
            const argsFile = path.join(dir, 'list-args');
            const script = writeScript(
                'list-ok.sh',
                `printf '%s\\n' "$@" > "${argsFile}"\n` +
                    `echo '[{"instanceId":"i-1","displayName":"grp-aaaaa","cloudStatus":"RUNNING"},` +
                    `{"instanceId":"i-2","cloudStatus":"terminated"}]'`,
            );
            const ctx = initContext();

            const result = await buildManager({ listScript: script }).getInstances(ctx, group, retryStrategy);

            assert.deepStrictEqual(result, [
                { instanceId: 'i-1', displayName: 'grp-aaaaa', cloudStatus: 'RUNNING' },
                // displayName defaults to the instance id
                { instanceId: 'i-2', displayName: 'i-2', cloudStatus: 'terminated' },
            ]);
            assert.equal(ctx.logger.warn.mock.calls.length, 0);
            assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), ['--groupName grp']);
        });

        test('treats empty output as no instances', async () => {
            const script = writeScript('list-empty.sh', 'exit 0');
            const ctx = initContext();

            const result = await buildManager({ listScript: script }).getInstances(ctx, group, retryStrategy);

            assert.deepEqual(result, []);
            assert.equal(ctx.logger.warn.mock.calls.length, 0);
        });

        test('returns [] with a warning when the list script prints invalid JSON', async () => {
            const script = writeScript('list-garbage.sh', 'echo "not json at all"');
            const ctx = initContext();

            const result = await buildManager({ listScript: script }).getInstances(ctx, group, retryStrategy);

            assert.deepEqual(result, []);
            const warnings = messages(ctx.logger.warn);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /Failed listing instances for group grp with .*list-garbage\.sh/);
            assert.match(warnings[0], /treating as no cloud instances/);
        });

        test('returns [] with a warning when the JSON does not describe an array of instances', async () => {
            const notArray = writeScript('list-object.sh', `echo '{"instanceId":"i-1","cloudStatus":"RUNNING"}'`);
            const missingId = writeScript('list-noid.sh', `echo '[{"displayName":"grp-a","cloudStatus":"RUNNING"}]'`);

            for (const [script, expected] of [
                [notArray, /expected a JSON array of instances/],
                [missingId, /item 0 is missing a string instanceId/],
            ]) {
                const ctx = initContext();
                const result = await buildManager({ listScript: script }).getInstances(ctx, group, retryStrategy);
                assert.deepEqual(result, []);
                assert.equal(ctx.logger.warn.mock.calls.length, 1);
                assert.match(messages(ctx.logger.warn)[0], expected);
            }
        });

        test('returns [] with a warning when the list script exits non-zero', async () => {
            const script = writeScript('list-fail.sh', `echo '[]'\necho "provider down" >&2\nexit 2`);
            const ctx = initContext();

            const result = await buildManager({ listScript: script }).getInstances(ctx, group, retryStrategy);

            assert.deepEqual(result, []);
            assert.equal(ctx.logger.warn.mock.calls.length, 1);
            assert.match(messages(ctx.logger.warn)[0], /Failed listing instances for group grp/);
        });

        test('returns [] with a warning when the list script exceeds the timeout', async () => {
            const script = writeScript('list-hang.sh', 'exec sleep 5');
            const ctx = initContext();
            const started = Date.now();

            const result = await buildManager({ listScript: script, timeoutMs: HANG_TIMEOUT_MS }).getInstances(
                ctx,
                group,
                retryStrategy,
            );

            assert.deepEqual(result, []);
            assert.ok(Date.now() - started < 4000);
            assert.equal(ctx.logger.warn.mock.calls.length, 1);
        });

        test('returns [] without a warning when no list script is configured', async () => {
            const ctx = initContext();

            const result = await buildManager({ listScript: undefined }).getInstances(ctx, group, retryStrategy);

            assert.deepEqual(result, []);
            assert.equal(ctx.logger.warn.mock.calls.length, 0);
            assert.ok(messages(ctx.logger.debug).some((m) => m.includes('No list script configured')));
        });

        test('accepts list output larger than the default 1MB execFile buffer', async () => {
            const count = 30000;
            const items = [];
            for (let i = 0; i < count; i++) {
                items.push({ instanceId: `i-${String(i).padStart(6, '0')}`, cloudStatus: 'RUNNING' });
            }
            const json = JSON.stringify(items);
            assert.ok(json.length > 1024 * 1024, 'fixture exceeds the default execFile maxBuffer');
            const jsonFile = path.join(dir, 'big.json');
            fs.writeFileSync(jsonFile, json);
            const script = writeScript('list-big.sh', `cat "${jsonFile}"`);
            const ctx = initContext();

            const result = await buildManager({ listScript: script }).getInstances(ctx, group, retryStrategy);

            assert.equal(result.length, count);
            assert.equal(ctx.logger.warn.mock.calls.length, 0);
        });
    });

    describe('execFile options', () => {
        afterEach(() => {
            mock.restoreAll();
        });

        test('passes the enlarged maxBuffer and the timeout for the list script', async () => {
            const execFile = mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => {
                callback(null, '[]', '');
            });

            await buildManager({ listScript: '/opt/list.sh', timeoutMs: 1234 }).getInstances(initContext(), group, {});

            assert.equal(execFile.mock.calls.length, 1);
            const [file, args, options] = execFile.mock.calls[0].arguments;
            assert.equal(file, '/opt/list.sh');
            assert.deepEqual(args, ['--groupName grp']);
            assert.deepEqual(options, { timeout: 1234, maxBuffer: LIST_SCRIPT_MAX_BUFFER });
        });

        test('passes the timeout and the default buffer for the launch script', async () => {
            const execFile = mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => {
                callback(null, 'i-1\n', '');
            });

            const result = await buildManager({ launchScript: '/opt/launch.sh', timeoutMs: 1234 }).launchInstances(
                initContext(),
                group,
                0,
                1,
            );

            assert.deepEqual(result, ['i-1']);
            const [file, , options] = execFile.mock.calls[0].arguments;
            assert.equal(file, '/opt/launch.sh');
            assert.deepEqual(options, { timeout: 1234, maxBuffer: undefined });
        });
    });
});
