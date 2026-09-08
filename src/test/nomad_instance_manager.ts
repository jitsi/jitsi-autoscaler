/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { beforeEach, describe, mock } from 'node:test';

import NomadInstanceManager from '../nomad_instance_manager';

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

describe('NomadInstanceManager', () => {
    const address = 'http://nomad.example.com:4646';
    const jobName = 'jibri-job';
    // nomad instance configuration looks like nomadURL|jobName
    const group = { name: 'grp', type: 'jibri', region: 'r', instanceConfigurationId: `${address}|${jobName}` };

    let manager;
    let dispatchJob;
    let listJobs;

    beforeEach(() => {
        manager = new NomadInstanceManager({ isDryRun: false });
        dispatchJob = mock.fn();
        listJobs = mock.fn();
        manager.nomadClient = { dispatchJob, listJobs };
    });

    describe('launchInstances', () => {
        test('dispatches the parameterized job once per instance and records the dispatched job ids', async () => {
            dispatchJob.mock.mockImplementation(async (_ctx, _address, _job, payload) => ({
                DispatchedJobID: `${jobName}/dispatch-${payload.name}`,
            }));
            const ctx = initContext();

            const result = await manager.launchInstances(ctx, group, 0, 2);

            assert.equal(result.length, 2);
            assert.ok(
                result.every((id) => /^jibri-job\/dispatch-[A-Za-z0-9]{5}$/.test(id)),
                `got ${result}`,
            );
            assert.equal(new Set(result).size, 2, 'distinct dispatched job ids');
            assert.equal(dispatchJob.mock.calls.length, 2);
            for (const call of dispatchJob.mock.calls) {
                const [callCtx, callAddress, callJob, payload, meta] = call.arguments;
                assert.strictEqual(callCtx, ctx);
                assert.equal(callAddress, address);
                assert.equal(callJob, jobName);
                assert.equal(payload.group, 'grp');
                assert.match(payload.name, /^[A-Za-z0-9]{5}$/);
                assert.deepStrictEqual(meta, payload);
            }
            assert.equal(ctx.logger.error.mock.calls.length, 0);
        });

        test('a rejected dispatch yields false for that instance only and is logged', async () => {
            dispatchJob.mock.mockImplementation(async () => {
                // launchInstance calls dispatchJob synchronously up to its first await, so the
                // second call belongs to instance number 2
                if (dispatchJob.mock.calls.length === 1) {
                    throw new Error('nomad returned 500');
                }
                return { DispatchedJobID: `${jobName}/dispatch-ok` };
            });
            const ctx = initContext();

            const result = await manager.launchInstances(ctx, group, 0, 2);

            assert.deepEqual(result, [`${jobName}/dispatch-ok`, false]);
            const errors = ctx.logger.error.mock.calls.map((call) => call.arguments[0]);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /\[nomad\] Failed launching instance number 2 in group grp/);
            assert.match(errors[0], /nomad returned 500/);
        });

        test('every dispatch failing resolves quantity x false without rejecting', async () => {
            dispatchJob.mock.mockImplementation(async () => {
                throw new Error('connection refused');
            });

            const result = await manager.launchInstances(initContext(), group, 0, 3);

            assert.deepEqual(result, [false, false, false]);
        });

        test('dry run resolves true without dispatching', async () => {
            manager.isDryRun = true;

            const result = await manager.launchInstances(initContext(), group, 0, 2);

            assert.deepEqual(result, [true, true]);
            assert.equal(dispatchJob.mock.calls.length, 0);
        });
    });

    describe('getInstances', () => {
        test('lists jobs by the dispatch prefix and maps nomad statuses to cloud statuses', async () => {
            listJobs.mock.mockImplementation(async () => [
                { ID: `${jobName}/dispatch-1`, Name: 'grp-aaaaa', Status: 'pending' },
                { ID: `${jobName}/dispatch-2`, Name: 'grp-bbbbb', Status: 'running' },
                { ID: `${jobName}/dispatch-3`, Name: 'grp-ccccc', Status: 'stopped' },
                { ID: `${jobName}/dispatch-4`, Name: 'grp-ddddd', Status: 'dead' },
                { ID: 42, Name: 'grp-eeeee', Status: 'something-new' },
            ]);
            const ctx = initContext();

            const result = await manager.getInstances(ctx, group, {});

            assert.deepStrictEqual(listJobs.mock.calls[0].arguments, [ctx, address, `${jobName}/`]);
            assert.deepStrictEqual(result, [
                { instanceId: `${jobName}/dispatch-1`, displayName: 'grp-aaaaa', cloudStatus: 'PROVISIONING' },
                { instanceId: `${jobName}/dispatch-2`, displayName: 'grp-bbbbb', cloudStatus: 'RUNNING' },
                { instanceId: `${jobName}/dispatch-3`, displayName: 'grp-ccccc', cloudStatus: 'SHUTDOWN' },
                { instanceId: `${jobName}/dispatch-4`, displayName: 'grp-ddddd', cloudStatus: 'SHUTDOWN' },
                // ids are always strings, unknown nomad states are reported as Unknown
                { instanceId: '42', displayName: 'grp-eeeee', cloudStatus: 'Unknown' },
            ]);
        });

        test('an empty job listing yields no instances', async () => {
            listJobs.mock.mockImplementation(async () => []);

            assert.deepEqual(await manager.getInstances(initContext(), group, {}), []);
        });

        test('a rejected job listing propagates to the caller', async () => {
            // unlike launchInstance, getInstances has no try/catch: CloudManager/SanityLoop own the error
            listJobs.mock.mockImplementation(async () => {
                throw new Error('nomad unavailable');
            });
            const ctx = initContext();

            await assert.rejects(manager.getInstances(ctx, group, {}), /nomad unavailable/);
            assert.equal(ctx.logger.error.mock.calls.length, 0);
        });
    });
});
