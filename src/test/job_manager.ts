/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-var-requires */
// @ts-nocheck

import assert from 'node:assert';
import Module from 'node:module';
import test, { describe, mock } from 'node:test';
import * as promClient from 'prom-client';

// ---------------------------------------------------------------------------------------------
// Module stubs. JobManager constructs a bee-queue Queue in its constructor and builds a Context
// (which transitively loads config.ts and its required env vars) per processed job. Both are
// replaced in the require cache BEFORE job_manager is loaded so the tests need neither a Redis
// server nor a .env file. bee-queue's Job API is mirrored just far enough for createJobs().
// ---------------------------------------------------------------------------------------------

class FakeJob {
    constructor(queue, data) {
        this.queue = queue;
        this.data = data;
        this.id = undefined;
        this.options = {};
    }
    setId(id) {
        this.id = id;
        return this;
    }
    timeout(ms) {
        this.options.timeout = ms;
        return this;
    }
    retries(n) {
        this.options.retries = n;
        return this;
    }
    async save() {
        return this.queue.saveJob(this);
    }
}

class FakeQueue {
    static instances = [];

    constructor(name, settings) {
        this.name = name;
        this.settings = settings;
        this.handlers = {};
        this.savedJobs = [];
        this.processFn = undefined;
        this.concurrency = undefined;
        this.health = { waiting: 0, active: 0, succeeded: 0, failed: 0, delayed: 0 };
        this.closeCalls = [];
        // Default save behaviour: accept the job and echo it back with the id that was set on it.
        this.saveJob = (job) => {
            this.savedJobs.push(job);
            return job;
        };
        FakeQueue.instances.push(this);
    }
    on(event, handler) {
        this.handlers[event] = handler;
        return this;
    }
    process(concurrency, fn) {
        this.concurrency = concurrency;
        this.processFn = fn;
    }
    createJob(data) {
        return new FakeJob(this, data);
    }
    async checkHealth() {
        if (this.health instanceof Error) {
            throw this.health;
        }
        return this.health;
    }
    async close(timeoutMs) {
        this.closeCalls.push(timeoutMs);
    }
}

class FakeContext {
    constructor(logger, start, requestId) {
        this.logger = logger;
        this.start = start;
        this.requestId = requestId;
    }
}

function stubModule(request, exports) {
    const filename = require.resolve(request);
    const stub = new Module(filename, module);
    stub.filename = filename;
    stub.loaded = true;
    stub.exports = exports;
    require.cache[filename] = stub;
}

stubModule('bee-queue', FakeQueue);
stubModule('../context', { __esModule: true, Context: FakeContext });

const { default: JobManager, JobType } = require('../job_manager');

async function counterValue(name, labels = {}) {
    const metric = await promClient.register.getSingleMetric(name).get();
    const wanted = JSON.stringify(labels);
    const entry = metric.values.find((v) => JSON.stringify(v.labels) === wanted);
    return entry ? entry.value : 0;
}

function makeLogger() {
    const logger = {
        info: mock.fn(),
        debug: mock.fn(),
        error: mock.fn(),
        warn: mock.fn(),
        child: mock.fn(),
    };
    logger.child.mock.mockImplementation(() => logger);
    return logger;
}

function loggedMessages(fn) {
    return fn.mock.calls.map((c) => c.arguments[0]);
}

describe('JobManager', () => {
    const groupNames = ['group-a', 'group-b'];

    function makeHarness(overrides = {}) {
        const logger = makeLogger();
        const ctx = new FakeContext(logger, Date.now(), 'test-request');

        const lock = { release: mock.fn(async () => undefined) };
        const lockManager = { lockJobCreation: mock.fn(async () => lock) };

        const instanceGroupManager = {
            isGroupJobsCreationAllowed: mock.fn(async () => true),
            isSanityJobsCreationAllowed: mock.fn(async () => true),
            setGroupJobsCreationGracePeriod: mock.fn(async () => true),
            setSanityJobsCreationGracePeriod: mock.fn(async () => true),
            getAllInstanceGroupNames: mock.fn(async () => groupNames),
        };

        const instanceLauncher = { launchOrShutdownInstancesByGroup: mock.fn(async () => true) };
        const autoscaler = { processAutoscalingByGroup: mock.fn(async () => true) };
        const scheduledScalingProcessor = { processScheduledScalingByGroup: mock.fn(async () => true) };
        const sanityLoop = { reportUntrackedInstances: mock.fn(async () => true) };
        const metricsLoop = { saveMetricQueueWaiting: mock.fn(async () => true) };

        const queueRedisOptions = { host: 'redis.test', port: 6379 };

        const before = FakeQueue.instances.length;
        const jobManager = new JobManager({
            logger,
            queueRedisOptions,
            lockManager,
            instanceGroupManager,
            instanceLauncher,
            autoscaler,
            scheduledScalingProcessor,
            sanityLoop,
            metricsLoop,
            autoscalerProcessingTimeoutMs: 1000,
            launcherProcessingTimeoutMs: 2000,
            sanityLoopProcessingTimeoutMs: 3000,
            jobsConcurrency: 5,
            ...overrides,
        });
        assert.strictEqual(FakeQueue.instances.length, before + 1, 'constructor creates exactly one queue');
        const queue = FakeQueue.instances[FakeQueue.instances.length - 1];

        return {
            ctx,
            logger,
            lock,
            lockManager,
            instanceGroupManager,
            instanceLauncher,
            autoscaler,
            scheduledScalingProcessor,
            sanityLoop,
            metricsLoop,
            queueRedisOptions,
            queue,
            jobManager,
        };
    }

    // Drive the bee-queue process callback the way bee-queue would, resolving with the done() args.
    function runProcess(queue, job) {
        return new Promise((resolve) => {
            queue.processFn(job, (err, result) => resolve({ err, result }));
        });
    }

    describe('queue construction', () => {
        test('creates the AutoscalerJobs queue with the redis options and cleanup settings', () => {
            const { queue, queueRedisOptions } = makeHarness();
            assert.strictEqual(queue.name, 'AutoscalerJobs');
            assert.deepStrictEqual(queue.settings, {
                redis: queueRedisOptions,
                removeOnSuccess: true,
                removeOnFailure: true,
            });
        });

        test('registers a processor with the configured concurrency and all queue event handlers', () => {
            const { queue } = makeHarness({ jobsConcurrency: 7 });
            assert.strictEqual(queue.concurrency, 7);
            assert.strictEqual(typeof queue.processFn, 'function');
            for (const event of ['error', 'failed', 'stalled', 'job succeeded', 'job retrying']) {
                assert.strictEqual(typeof queue.handlers[event], 'function', `handler for '${event}'`);
            }
        });
    });

    describe('createGroupProcessingJobs', () => {
        test('returns early without locking when group job creation is not allowed', async () => {
            const h = makeHarness();
            h.instanceGroupManager.isGroupJobsCreationAllowed.mock.mockImplementation(async () => false);

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.lockManager.lockJobCreation.mock.calls.length, 0);
            assert.strictEqual(h.instanceGroupManager.getAllInstanceGroupNames.mock.calls.length, 0);
            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.ok(loggedMessages(h.logger.info).some((m) => m.includes('Wait before allowing job creation')));
        });

        test('returns early and warns when the job creation lock cannot be obtained; no release is attempted', async () => {
            const h = makeHarness();
            const lockError = new Error('lock busy');
            h.lockManager.lockJobCreation.mock.mockImplementation(async () => {
                throw lockError;
            });

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.lock.release.mock.calls.length, 0);
            assert.strictEqual(h.instanceGroupManager.setGroupJobsCreationGracePeriod.mock.calls.length, 0);
            assert.strictEqual(h.instanceGroupManager.getAllInstanceGroupNames.mock.calls.length, 0);
            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.strictEqual(h.logger.warn.mock.calls.length, 1);
            assert.ok(h.logger.warn.mock.calls[0].arguments[0].includes('Error obtaining lock for creating jobs'));
            assert.strictEqual(h.logger.warn.mock.calls[0].arguments[1].err, lockError);
        });

        test('re-checks the creation flag after locking and releases the lock without creating jobs if it flipped', async () => {
            const h = makeHarness();
            let calls = 0;
            h.instanceGroupManager.isGroupJobsCreationAllowed.mock.mockImplementation(async () => {
                calls++;
                return calls === 1; // allowed before the lock, denied after another node took the window
            });

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.instanceGroupManager.isGroupJobsCreationAllowed.mock.calls.length, 2);
            assert.strictEqual(h.lockManager.lockJobCreation.mock.calls.length, 1);
            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.strictEqual(h.instanceGroupManager.setGroupJobsCreationGracePeriod.mock.calls.length, 0);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('creates scheduled scaling, autoscale and launch jobs per group with deterministic ids and timeouts', async () => {
            const h = makeHarness();
            const scheduledBefore = await counterValue('autoscaling_job_create_total', {
                type: JobType.ScheduledScaling,
            });
            const autoscaleBefore = await counterValue('autoscaling_job_create_total', { type: JobType.Autoscale });
            const launchBefore = await counterValue('autoscaling_job_create_total', { type: JobType.Launch });

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            const saved = h.queue.savedJobs;
            assert.strictEqual(saved.length, 6);
            const byId = new Map(saved.map((j) => [j.id, j]));
            for (const groupName of groupNames) {
                for (const [type, timeout] of [
                    [JobType.ScheduledScaling, 1000],
                    [JobType.Autoscale, 1000],
                    [JobType.Launch, 2000],
                ]) {
                    const job = byId.get(`${type}:${groupName}`);
                    assert.ok(job, `job ${type}:${groupName} was enqueued`);
                    assert.deepStrictEqual(job.data, { groupName, type });
                    assert.strictEqual(job.options.timeout, timeout);
                    assert.strictEqual(job.options.retries, 0);
                }
            }
            // no SANITY jobs in the group processing cycle
            assert.ok(saved.every((j) => j.data.type !== JobType.Sanity));

            assert.strictEqual(
                await counterValue('autoscaling_job_create_total', { type: JobType.ScheduledScaling }),
                scheduledBefore + 2,
            );
            assert.strictEqual(
                await counterValue('autoscaling_job_create_total', { type: JobType.Autoscale }),
                autoscaleBefore + 2,
            );
            assert.strictEqual(
                await counterValue('autoscaling_job_create_total', { type: JobType.Launch }),
                launchBefore + 2,
            );
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
            assert.strictEqual(h.lock.release.mock.calls[0].arguments[0], h.ctx);
        });

        test('marks the creation window used BEFORE enqueuing any job', async () => {
            const h = makeHarness();
            const sequence = [];
            h.instanceGroupManager.setGroupJobsCreationGracePeriod.mock.mockImplementation(async () => {
                sequence.push('grace');
                return true;
            });
            h.queue.saveJob = (job) => {
                sequence.push('save');
                h.queue.savedJobs.push(job);
                return job;
            };

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.instanceGroupManager.setGroupJobsCreationGracePeriod.mock.calls.length, 1);
            assert.strictEqual(sequence[0], 'grace');
            assert.strictEqual(sequence.filter((s) => s === 'save').length, 6);
        });

        test('records queue residual from the previous cycle before creating new jobs', async () => {
            const h = makeHarness();
            h.queue.health = { waiting: 4, active: 1, succeeded: 0, failed: 0, delayed: 0 };
            let savedWhenMeasured = -1;
            h.metricsLoop.saveMetricQueueWaiting.mock.mockImplementation(async () => {
                savedWhenMeasured = h.queue.savedJobs.length;
                return true;
            });

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.metricsLoop.saveMetricQueueWaiting.mock.calls.length, 1);
            assert.strictEqual(h.metricsLoop.saveMetricQueueWaiting.mock.calls[0].arguments[0], 4);
            assert.strictEqual(savedWhenMeasured, 0);
        });

        test('skips and logs a job whose id is still pending from a previous cycle (bee-queue returns null id)', async () => {
            const h = makeHarness();
            const failureBefore = await counterValue('autoscaling_job_create_failure_total', {
                type: JobType.Autoscale,
            });
            h.queue.saveJob = (job) => {
                h.queue.savedJobs.push(job);
                if (job.id === `${JobType.Autoscale}:group-a`) {
                    // bee-queue resolves the job with a null id when the deterministic id already exists
                    return Object.assign(Object.create(Object.getPrototypeOf(job)), job, { id: null });
                }
                return job;
            };

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            const infos = loggedMessages(h.logger.info);
            assert.ok(
                infos.some(
                    (m) =>
                        m.includes('AUTOSCALE job for group group-a is still pending from a previous cycle') &&
                        m.includes('not enqueuing a duplicate'),
                ),
            );
            assert.ok(
                infos.some((m) => m === '[JobManager] Job created AUTOSCALE:AUTOSCALE:group-b for group group-b'),
            );
            // a duplicate is not a failure
            assert.strictEqual(
                await counterValue('autoscaling_job_create_failure_total', { type: JobType.Autoscale }),
                failureBefore,
            );
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('a save() rejection for one job is logged and counted, other jobs are still created', async () => {
            const h = makeHarness();
            const failureBefore = await counterValue('autoscaling_job_create_failure_total', {
                type: JobType.Launch,
            });
            h.queue.saveJob = (job) => {
                if (job.id === `${JobType.Launch}:group-b`) {
                    throw new Error('redis down');
                }
                h.queue.savedJobs.push(job);
                return job;
            };

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.queue.savedJobs.length, 5);
            assert.ok(
                loggedMessages(h.logger.info).some((m) =>
                    m.includes('Error while creating LAUNCH job for group group-b: Error: redis down'),
                ),
            );
            assert.strictEqual(
                await counterValue('autoscaling_job_create_failure_total', { type: JobType.Launch }),
                failureBefore + 1,
            );
            assert.strictEqual(h.logger.error.mock.calls.length, 0, 'per-job save errors are not cycle errors');
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('releases the lock and logs when job creation throws part-way through', async () => {
            const h = makeHarness();
            h.instanceGroupManager.getAllInstanceGroupNames.mock.mockImplementation(async () => {
                throw new Error('store unavailable');
            });

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.strictEqual(h.logger.error.mock.calls.length, 1);
            assert.ok(
                h.logger.error.mock.calls[0].arguments[0].includes(
                    'Error while creating jobs for group Error: store unavailable',
                ),
            );
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('releases the lock even when the queue health check rejects', async () => {
            const h = makeHarness();
            h.queue.health = new Error('queue redis unreachable');

            await h.jobManager.createGroupProcessingJobs(h.ctx);

            assert.strictEqual(h.metricsLoop.saveMetricQueueWaiting.mock.calls.length, 0);
            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.strictEqual(h.logger.error.mock.calls.length, 1);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });
    });

    describe('createSanityProcessingJobs', () => {
        test('returns early without locking when sanity job creation is not allowed', async () => {
            const h = makeHarness();
            h.instanceGroupManager.isSanityJobsCreationAllowed.mock.mockImplementation(async () => false);

            await h.jobManager.createSanityProcessingJobs(h.ctx);

            assert.strictEqual(h.lockManager.lockJobCreation.mock.calls.length, 0);
            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.ok(
                loggedMessages(h.logger.info).some((m) => m.includes('Wait before allowing sanity job creation')),
            );
        });

        test('returns early and warns when the lock cannot be obtained; no release is attempted', async () => {
            const h = makeHarness();
            h.lockManager.lockJobCreation.mock.mockImplementation(async () => {
                throw new Error('lock busy');
            });

            await h.jobManager.createSanityProcessingJobs(h.ctx);

            assert.strictEqual(h.lock.release.mock.calls.length, 0);
            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.strictEqual(h.logger.warn.mock.calls.length, 1);
            assert.ok(
                h.logger.warn.mock.calls[0].arguments[0].includes('Error obtaining lock for creating sanity jobs'),
            );
        });

        test('creates one SANITY job per group with deterministic ids, then sets the grace period and releases the lock', async () => {
            const h = makeHarness();
            const sequence = [];
            h.instanceGroupManager.setSanityJobsCreationGracePeriod.mock.mockImplementation(async () => {
                sequence.push('grace');
                return true;
            });
            h.queue.saveJob = (job) => {
                sequence.push('save');
                h.queue.savedJobs.push(job);
                return job;
            };
            const totalBefore = await counterValue('autoscaling_job_create_total', { type: JobType.Sanity });

            await h.jobManager.createSanityProcessingJobs(h.ctx);

            assert.deepStrictEqual(h.queue.savedJobs.map((j) => j.id).sort(), ['SANITY:group-a', 'SANITY:group-b']);
            for (const job of h.queue.savedJobs) {
                assert.strictEqual(job.data.type, JobType.Sanity);
                assert.strictEqual(job.options.timeout, 3000);
                assert.strictEqual(job.options.retries, 0);
            }
            // the sanity path sets the grace period AFTER enqueuing (unlike the group processing path)
            assert.deepStrictEqual(sequence, ['save', 'save', 'grace']);
            assert.strictEqual(
                await counterValue('autoscaling_job_create_total', { type: JobType.Sanity }),
                totalBefore + 2,
            );
            assert.strictEqual(h.metricsLoop.saveMetricQueueWaiting.mock.calls.length, 0);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('logs, counts a SANITY failure and releases the lock when job creation throws', async () => {
            const h = makeHarness();
            const failureBefore = await counterValue('autoscaling_job_create_failure_total', {
                type: JobType.Sanity,
            });
            h.instanceGroupManager.getAllInstanceGroupNames.mock.mockImplementation(async () => {
                throw new Error('store unavailable');
            });

            await h.jobManager.createSanityProcessingJobs(h.ctx);

            assert.strictEqual(h.queue.savedJobs.length, 0);
            assert.strictEqual(h.instanceGroupManager.setSanityJobsCreationGracePeriod.mock.calls.length, 0);
            assert.ok(h.logger.error.mock.calls[0].arguments[0].includes('Error while creating sanity jobs for group'));
            assert.strictEqual(
                await counterValue('autoscaling_job_create_failure_total', { type: JobType.Sanity }),
                failureBefore + 1,
            );
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });
    });

    describe('job processing', () => {
        const dispatchCases = [
            [JobType.ScheduledScaling, 'scheduledScalingProcessor', 'processScheduledScalingByGroup'],
            [JobType.Autoscale, 'autoscaler', 'processAutoscalingByGroup'],
            [JobType.Launch, 'instanceLauncher', 'launchOrShutdownInstancesByGroup'],
            [JobType.Sanity, 'sanityLoop', 'reportUntrackedInstances'],
        ];

        for (const [type, component, method] of dispatchCases) {
            test(`dispatches a ${type} job to ${component}.${method} with a per-job context and completes with its result`, async () => {
                const h = makeHarness();
                const totalBefore = await counterValue('autoscaling_job_process_total', { type });
                const job = { id: `${type}:group-a`, data: { groupName: 'group-a', type } };

                const { err, result } = await runProcess(h.queue, job);

                assert.strictEqual(err, null);
                assert.strictEqual(result, true);
                const handler = h[component][method];
                assert.strictEqual(handler.mock.calls.length, 1);
                const [ctxArg, groupArg] = handler.mock.calls[0].arguments;
                assert.ok(ctxArg instanceof FakeContext);
                assert.strictEqual(ctxArg.logger, h.logger);
                assert.strictEqual(typeof ctxArg.requestId, 'string');
                assert.strictEqual(groupArg, 'group-a');
                // a child logger tagged with the poll id is created per job
                assert.strictEqual(h.logger.child.mock.calls.length, 1);
                assert.strictEqual(h.logger.child.mock.calls[0].arguments[0].id, ctxArg.requestId);
                // only the handler for this type ran
                for (const [, otherComponent, otherMethod] of dispatchCases) {
                    if (otherComponent !== component) {
                        assert.strictEqual(h[otherComponent][otherMethod].mock.calls.length, 0);
                    }
                }
                assert.strictEqual(await counterValue('autoscaling_job_process_total', { type }), totalBefore + 1);
            });
        }

        test('completes with false (not an error) when the processor could not acquire its group lock', async () => {
            const h = makeHarness();
            h.autoscaler.processAutoscalingByGroup.mock.mockImplementation(async () => false);
            const job = { id: 'AUTOSCALE:group-a', data: { groupName: 'group-a', type: JobType.Autoscale } };

            const { err, result } = await runProcess(h.queue, job);

            assert.strictEqual(err, null);
            assert.strictEqual(result, false);
        });

        test('fails the job with the processor error and defers the failure count to the queue failed event', async () => {
            const h = makeHarness();
            const failure = new Error('provider exploded');
            h.instanceLauncher.launchOrShutdownInstancesByGroup.mock.mockImplementation(async () => {
                throw failure;
            });
            const totalBefore = await counterValue('autoscaling_job_process_total', { type: JobType.Launch });
            const failureBefore = await counterValue('autoscaling_job_process_failure_total', {
                type: JobType.Launch,
            });
            const job = { id: 'LAUNCH:group-a', data: { groupName: 'group-a', type: JobType.Launch } };

            const { err, result } = await runProcess(h.queue, job);

            assert.strictEqual(err, failure);
            assert.strictEqual(result, false);
            assert.ok(
                loggedMessages(h.logger.info).some((m) =>
                    m.includes(
                        'Error processing job LAUNCH:LAUNCH:group-a for group group-a: Error: provider exploded',
                    ),
                ),
            );
            // neither counter moves here; bee-queue's 'failed' event is where failures are accounted
            assert.strictEqual(
                await counterValue('autoscaling_job_process_total', { type: JobType.Launch }),
                totalBefore,
            );
            assert.strictEqual(
                await counterValue('autoscaling_job_process_failure_total', { type: JobType.Launch }),
                failureBefore,
            );
        });

        test('fails a job of unknown type', async () => {
            const h = makeHarness();
            const job = { id: 'BOGUS:group-a', data: { groupName: 'group-a', type: 'BOGUS' } };

            const { err, result } = await runProcess(h.queue, job);

            assert.ok(err instanceof Error);
            assert.strictEqual(err.message, 'Unkown job type');
            assert.strictEqual(result, false);
        });

        test('the failed event (including bee-queue timeouts) counts a processed and a failed job of that type', async () => {
            const h = makeHarness();
            const totalBefore = await counterValue('autoscaling_job_process_total', { type: JobType.Sanity });
            const failureBefore = await counterValue('autoscaling_job_process_failure_total', {
                type: JobType.Sanity,
            });
            const job = { id: 'SANITY:group-a', data: { groupName: 'group-a', type: JobType.Sanity } };
            const timeoutError = new Error('Job 1 timed out (3000 ms)');

            h.queue.handlers['failed'](job, timeoutError);

            assert.strictEqual(
                await counterValue('autoscaling_job_process_total', { type: JobType.Sanity }),
                totalBefore + 1,
            );
            assert.strictEqual(
                await counterValue('autoscaling_job_process_failure_total', { type: JobType.Sanity }),
                failureBefore + 1,
            );
            assert.strictEqual(h.logger.error.mock.calls.length, 1);
            assert.ok(
                h.logger.error.mock.calls[0].arguments[0].includes(
                    'Failed processing job SANITY:SANITY:group-a with error message Job 1 timed out (3000 ms)',
                ),
            );
            assert.strictEqual(h.logger.error.mock.calls[0].arguments[1].err, timeoutError);
        });

        test('queue error and stalled events are logged and counted', async () => {
            const h = makeHarness();
            const errorsBefore = await counterValue('autoscaling_queue_error_total');
            const stalledBefore = await counterValue('autoscaling_queue_stalled_total');

            h.queue.handlers['error'](new Error('ECONNRESET'));
            h.queue.handlers['stalled']('AUTOSCALE:group-a');

            assert.strictEqual(await counterValue('autoscaling_queue_error_total'), errorsBefore + 1);
            assert.strictEqual(await counterValue('autoscaling_queue_stalled_total'), stalledBefore + 1);
            const errors = loggedMessages(h.logger.error);
            assert.ok(errors.some((m) => m.includes('A queue error happened in queue AutoscalerJobs: ECONNRESET')));
            assert.ok(errors.some((m) => m.includes('Stalled job AUTOSCALE:group-a; will be reprocessed')));
        });

        test('job succeeded and job retrying events are logged at info level', () => {
            const h = makeHarness();

            h.queue.handlers['job succeeded']('AUTOSCALE:group-a', true);
            h.queue.handlers['job retrying']('LAUNCH:group-b', new Error('flaky'));

            const infos = loggedMessages(h.logger.info);
            assert.ok(infos.some((m) => m === 'Job AUTOSCALE:group-a succeeded with result: true'));
            assert.ok(infos.some((m) => m === 'Job LAUNCH:group-b failed with error flaky but is being retried!'));
        });
    });

    describe('lifecycle', () => {
        test('isHealthy reflects whether the queue health check succeeds', async () => {
            const h = makeHarness();
            assert.strictEqual(await h.jobManager.isHealthy(), true);

            h.queue.health = new Error('redis gone');
            assert.strictEqual(await h.jobManager.isHealthy(), false);
        });

        test('close forwards the timeout to the queue (default 10000 ms)', async () => {
            const h = makeHarness();
            await h.jobManager.close();
            await h.jobManager.close(250);
            assert.deepStrictEqual(h.queue.closeCalls, [10000, 250]);
        });
    });
});
