import test, { ExecutionContext } from 'ava';

import AutoscalerLogger from '../logger';
const asLogger = new AutoscalerLogger({ logLevel: 'DEBUG' });
const logger = asLogger.createLogger();

import { NomadClient } from '../nomad';
import { Context } from '../context';

const nomadClient = new NomadClient();

const nomadAddress = 'https://beta-meet-jit-si-us-phoenix-1-nomad.jitsi.net';

const jobName = 'fabio';

// const expected = <NomadJob[]>[{}];

const ctx = new Context(logger, 0, 'nomad.test');

test('list nomad jobs', async (t: ExecutionContext) => {
    const jobs = await nomadClient.listJobs(ctx, nomadAddress, jobName);
    t.is(jobs.length, 1);

    const job = jobs[0];
    t.is(job.ID, jobName);
    t.is(job.Name, jobName);
    t.is(job.Namespace, 'default');
    t.is(job.Type, 'system');
});
