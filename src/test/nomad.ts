/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import net from 'node:net';
import test, { afterEach, beforeEach, describe, mock } from 'node:test';

import got from 'got';
import { NomadClient } from '../nomad';

describe('NomadClient', () => {
    const nomadClient = new NomadClient();
    const defaultRequestOptions = { timeout: { request: 30000 }, retry: { limit: 0 } };
    const context = { logger: { debug: mock.fn() } };

    afterEach(() => {
        mock.restoreAll();
    });

    describe('listJobs', () => {
        const jobs = { 1: {}, 2: {} };

        beforeEach(() => {
            mock.method(got, 'get', () => ({ json: () => jobs }));
        });

        test('will call the correct endpoint with the default request timeout', async () => {
            const server = 'https://nomad.example.com:4646';
            const prefix = 'prefix';

            await nomadClient.listJobs(context, server, prefix);

            assert.strictEqual(got.get.mock.calls[0].arguments[0], `${server}/v1/jobs?prefix=${prefix}`);
            assert.deepEqual(got.get.mock.calls[0].arguments[1], defaultRequestOptions);
        });

        test('will honour a configured request timeout', async () => {
            const client = new NomadClient({ requestTimeoutMs: 1234 });

            await client.listJobs(context, 'https://nomad.example.com:4646', '');

            assert.deepEqual(got.get.mock.calls[0].arguments[1], { timeout: { request: 1234 }, retry: { limit: 0 } });
        });

        test('will perform a GET and return the list of jobs', async () => {
            const result = await nomadClient.listJobs(context, '', '');

            assert.strictEqual(result, jobs);
        });
    });

    describe('against a real socket', () => {
        test('a dropped connection leaves no retried request running behind the rejected caller', async () => {
            // Regression for the got 11 retry-after-settle crash (see the matching test in asap.ts). The first
            // connection is dropped (a retryable error) and any later one is held open, as a dead network would.
            const sockets = [];
            const server = net.createServer((socket) => {
                sockets.push(socket);
                socket.on('error', () => {});
                if (sockets.length === 1) {
                    socket.destroy();
                }
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const client = new NomadClient({ requestTimeoutMs: 3000 });
                const baseUrl = `https://127.0.0.1:${server.address().port}`;

                await assert.rejects(client.listJobs(context, baseUrl, ''));

                // got's first retry would fire about 1s after the failure. Wait past it: nothing may reconnect.
                await new Promise((resolve) => setTimeout(resolve, 1500));
                assert.strictEqual(sockets.length, 1);
            } finally {
                sockets.forEach((socket) => socket.destroy());
                await new Promise((resolve) => server.close(resolve));
            }
        });
    });

    describe('dispatchJob', () => {
        const dispatchResult = {
            Index: 1,
            JobCreateIndex: 2,
            EvalCreateIndex: 3,
            EvalID: 'eval-id',
            DispatchedJobID: 'dispatched-job-id',
        };

        const server = 'https://nomad.example.com:4646';
        const job = 'job';
        const payload = { id: 'job-id' };
        const meta = { meta: 'data' };

        beforeEach(() => {
            mock.method(got, 'post', () => ({ json: () => dispatchResult }));
        });

        test('will call the correct endpoint and with the correct payload and timeout', async () => {
            await nomadClient.dispatchJob(context, server, job, payload, meta);

            assert.strictEqual(got.post.mock.calls[0].arguments[0], `${server}/v1/job/${job}/dispatch`);
            assert.deepEqual(got.post.mock.calls[0].arguments[1], {
                json: { Meta: meta, Payload: Buffer.from(JSON.stringify(payload)).toString('base64') },
                ...defaultRequestOptions,
            });
        });

        test('will perform a POST and return the dispatch result', async () => {
            const result = await nomadClient.dispatchJob(context, server, job, payload, meta);

            assert.strictEqual(result, dispatchResult);
        });
    });
});
