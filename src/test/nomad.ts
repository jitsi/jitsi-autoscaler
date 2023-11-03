/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, beforeEach, describe, mock } from 'node:test';

import got from 'got';
import { NomadClient } from '../nomad';

describe('NomadClient', () => {
    const nomadClient = new NomadClient();
    const context = { logger: { debug: mock.fn() } };

    afterEach(() => {
        mock.restoreAll();
    });

    describe('listJobs', () => {
        const jobs = { 1: {}, 2: {} };

        beforeEach(() => {
            mock.method(got, 'get', () => ({ json: () => jobs }));
        });

        test('will call the correct endpoint', async () => {
            const server = 'https://nomad.example.com:4646';
            const prefix = 'prefix';

            await nomadClient.listJobs(context, server, prefix);

            assert.strictEqual(got.get.mock.calls[0].arguments[0], `${server}/v1/jobs?prefix=${prefix}`);
        });

        test('will perform a GET and return the list of jobs', async () => {
            const result = await nomadClient.listJobs(context, '', '');

            assert.strictEqual(result, jobs);
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

        test('will call the correct endpoint and with the correct payload', async () => {
            await nomadClient.dispatchJob(context, server, job, payload, meta);

            assert.strictEqual(got.post.mock.calls[0].arguments[0], `${server}/v1/job/${job}/dispatch`);
            assert.deepEqual(got.post.mock.calls[0].arguments[1], {
                json: { Meta: meta, Payload: Buffer.from(JSON.stringify(payload)).toString('base64') },
            });
        });

        test('will perform a POST and return the dispatch result', async () => {
            const result = await nomadClient.dispatchJob(context, server, job, payload, meta);

            assert.strictEqual(result, dispatchResult);
        });
    });
});
