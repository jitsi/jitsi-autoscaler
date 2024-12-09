import Queue, { DoneCallback, Job } from 'bee-queue';
import InstanceGroupManager from './instance_group';
import * as context from './context';
import shortid from 'shortid';
import { Logger } from 'winston';
import { ClientOpts } from 'redis';
import InstanceLauncher from './instance_launcher';
import AutoscaleProcessor from './autoscaler';
import LockManager from './lock_manager';
import { AutoscalerLock } from './lock';
import * as promClient from 'prom-client';
import SanityLoop from './sanity_loop';
import MetricsLoop from './metrics_loop';
import { Context } from './context';

export interface JobManagerOptions {
    logger: Logger;
    queueRedisOptions: ClientOpts;
    lockManager: LockManager;
    instanceGroupManager: InstanceGroupManager;
    instanceLauncher: InstanceLauncher;
    autoscaler: AutoscaleProcessor;
    sanityLoop: SanityLoop;
    metricsLoop: MetricsLoop;
    autoscalerProcessingTimeoutMs: number;
    launcherProcessingTimeoutMs: number;
    sanityLoopProcessingTimeoutMs: number;
}

export enum JobType {
    Autoscale = 'AUTOSCALE',
    Launch = 'LAUNCH',
    Sanity = 'SANITY',
}

const jobCreateFailureCounter = new promClient.Counter({
    name: 'autoscaling_job_create_failure_total',
    help: 'Counter for jobs failed to create',
    labelNames: ['type'],
});
jobCreateFailureCounter.labels(JobType.Autoscale).inc(0);
jobCreateFailureCounter.labels(JobType.Launch).inc(0);
jobCreateFailureCounter.labels(JobType.Sanity).inc(0);

const jobCreateTotalCounter = new promClient.Counter({
    name: 'autoscaling_job_create_total',
    help: 'Counter for total job create operations',
    labelNames: ['type'],
});
jobCreateTotalCounter.labels(JobType.Autoscale).inc(0);
jobCreateTotalCounter.labels(JobType.Launch).inc(0);
jobCreateTotalCounter.labels(JobType.Sanity).inc(0);

const jobProcessFailureCounter = new promClient.Counter({
    name: 'autoscaling_job_process_failure_total',
    help: 'Counter for jobs processing failures',
    labelNames: ['type'],
});
jobProcessFailureCounter.labels(JobType.Autoscale).inc(0);
jobProcessFailureCounter.labels(JobType.Launch).inc(0);
jobProcessFailureCounter.labels(JobType.Sanity).inc(0);

const jobProcessTotalCounter = new promClient.Counter({
    name: 'autoscaling_job_process_total',
    help: 'Counter for total jobs processed',
    labelNames: ['type'],
});
jobProcessTotalCounter.labels(JobType.Autoscale).inc(0);
jobProcessTotalCounter.labels(JobType.Launch).inc(0);
jobProcessTotalCounter.labels(JobType.Sanity).inc(0);

const queueErrorCounter = new promClient.Counter({
    name: 'autoscaling_queue_error_total',
    help: 'Counter for queue errors',
});

const queueStalledCounter = new promClient.Counter({
    name: 'autoscaling_queue_stalled_total',
    help: 'Counter for stalled job events',
});

export interface JobData {
    groupName: string;
    type: JobType;
}

export default class JobManager {
    private static readonly jobQueueName = 'AutoscalerJobs';

    private lockManager: LockManager;
    private instanceGroupManager: InstanceGroupManager;
    private instanceLauncher: InstanceLauncher;
    private autoscaler: AutoscaleProcessor;
    private sanityLoop: SanityLoop;
    private metricsLoop: MetricsLoop;
    private jobQueue: Queue;
    private autoscalerProcessingTimeoutMs: number;
    private launcherProcessingTimeoutMs: number;
    private sanityLoopProcessingTimeoutMs: number;
    private logger: Logger;

    constructor(options: JobManagerOptions) {
        this.logger = options.logger;
        this.lockManager = options.lockManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.instanceLauncher = options.instanceLauncher;
        this.autoscaler = options.autoscaler;
        this.sanityLoop = options.sanityLoop;
        this.metricsLoop = options.metricsLoop;
        this.autoscalerProcessingTimeoutMs = options.autoscalerProcessingTimeoutMs;
        this.launcherProcessingTimeoutMs = options.launcherProcessingTimeoutMs;
        this.sanityLoopProcessingTimeoutMs = options.sanityLoopProcessingTimeoutMs;

        this.jobQueue = this.createQueue(JobManager.jobQueueName, options.queueRedisOptions);
    }

    createQueue(queueName: string, redisClientOptions: ClientOpts): Queue {
        const newQueue = new Queue(queueName, {
            redis: redisClientOptions,
            removeOnSuccess: true,
            removeOnFailure: true,
        });
        newQueue.on('error', (err) => {
            this.logger.error(`[QueueProcessor] A queue error happened in queue ${queueName}: ${err.message}`, { err });
            queueErrorCounter.inc();
        });
        newQueue.on('failed', (job, err) => {
            this.logger.error(
                `[QueueProcessor] Failed processing job ${job.data.type}:${job.id} with error message ${err.message}`,
                { err },
            );
            const jobData: JobData = job.data;
            jobProcessTotalCounter.inc({ type: jobData.type });
            jobProcessFailureCounter.inc({ type: jobData.type });
        });
        newQueue.on('stalled', (jobId) => {
            this.logger.error(`[QueueProcessor] Stalled job ${jobId}; will be reprocessed`);
            queueStalledCounter.inc();
        });
        newQueue.on('job succeeded', (jobId, result) => {
            this.logger.info(`Job ${jobId} succeeded with result: ${result}`);
        });
        newQueue.on('job retrying', (jobId, err) => {
            this.logger.info(`Job ${jobId} failed with error ${err.message} but is being retried!`);
        });

        newQueue.process((job: Job<JobData>, done: DoneCallback<boolean>) => {
            let ctx;
            const start = process.hrtime();

            try {
                const start = Date.now();
                const pollId = shortid.generate();
                const pollLogger = this.logger.child({
                    id: pollId,
                });
                ctx = new context.Context(pollLogger, start, pollId);

                switch (job.data.type) {
                    case JobType.Autoscale:
                        this.processJob(
                            ctx,
                            job,
                            (ctx, group) => this.autoscaler.processAutoscalingByGroup(ctx, group),
                            done,
                        );
                        break;
                    case JobType.Launch:
                        this.processJob(
                            ctx,
                            job,
                            (ctx, group) => this.instanceLauncher.launchOrShutdownInstancesByGroup(ctx, group),
                            done,
                        );
                        break;
                    case JobType.Sanity:
                        this.processJob(
                            ctx,
                            job,
                            (ctx, group) => this.sanityLoop.reportUntrackedInstances(ctx, group),
                            done,
                        );
                        break;
                    default:
                        this.processJob(ctx, job, () => this.handleUnknownJobType(), done);
                }
            } catch (error) {
                if (ctx) {
                    const delta = process.hrtime(start);
                    ctx.logger.error(
                        `[QueueProcessor] Unexpected error processing job ${job}: ${error}, after ${
                            delta[0] * 1000 + delta[1] / 1000000
                        } ms`,
                    );
                }
                // Ensure done is returned in case of unexpected errors
                return done(error, false);
            }
        });
        return newQueue;
    }

    async handleUnknownJobType(): Promise<boolean> {
        throw new Error('Unkown job type');
    }

    processJob(
        ctx: Context,
        job: Job<JobData>,
        processingHandler: (ctx: context.Context, group: string) => Promise<boolean>,
        done: DoneCallback<boolean>,
    ): void {
        const start = process.hrtime();
        const jobData: JobData = job.data;
        ctx.logger.info(
            `[QueueProcessor] Start processing job ${jobData.type}:${job.id} for group ${jobData.groupName}`,
        );

        processingHandler(ctx, jobData.groupName)
            .then((result: boolean) => {
                const delta = process.hrtime(start);
                ctx.logger.info(
                    `[QueueProcessor] Done processing job ${jobData.type}:${job.id} for group ${jobData.groupName} in ${
                        delta[0] * 1000 + delta[1] / 1000000
                    } ms`,
                );
                jobProcessTotalCounter.inc({ type: jobData.type });
                return done(null, result);
            })
            .catch((error) => {
                const delta = process.hrtime(start);
                ctx.logger.info(
                    `[QueueProcessor] Error processing job ${jobData.type}:${job.id} for group ${
                        jobData.groupName
                    }: ${error}, after ${delta[0] * 1000 + delta[1] / 1000000} ms`,
                    {
                        jobId: job.id,
                        jobData: jobData,
                    },
                );
                // we don't increase the jobProcessFailureCounter here,
                // as we increase it on the queue failed event, where we can catch timeout errors
                return done(error, false);
            });
    }

    async createSanityProcessingJobs(ctx: context.Context): Promise<void> {
        if (!(await this.instanceGroupManager.isSanityJobsCreationAllowed(ctx))) {
            ctx.logger.info('[JobManager] Wait before allowing sanity job creation');
            return;
        }

        let lock: AutoscalerLock = undefined;
        try {
            lock = await this.lockManager.lockJobCreation(ctx);
        } catch (err) {
            ctx.logger.warn(`[JobManager] Error obtaining lock for creating sanity jobs`, { err });
            return;
        }

        try {
            if (!(await this.instanceGroupManager.isSanityJobsCreationAllowed(ctx))) {
                ctx.logger.info('[JobManager] Wait before allowing sanity job creation');
                return;
            }

            const instanceGroupNames = await this.instanceGroupManager.getAllInstanceGroupNames(ctx);

            await this.createJobs(
                ctx,
                instanceGroupNames,
                this.jobQueue,
                JobType.Sanity,
                this.sanityLoopProcessingTimeoutMs,
            );

            await this.instanceGroupManager.setSanityJobsCreationGracePeriod(ctx);
        } catch (err) {
            ctx.logger.error(`[JobManager] Error while creating sanity jobs for group ${err}`);
            jobCreateFailureCounter.inc({ type: JobType.Sanity });
        } finally {
            await lock.release();
        }
    }

    async createGroupProcessingJobs(ctx: context.Context): Promise<void> {
        if (!(await this.instanceGroupManager.isGroupJobsCreationAllowed(ctx))) {
            ctx.logger.info('[JobManager] Wait before allowing job creation');
            return;
        }

        let lock: AutoscalerLock = undefined;
        try {
            lock = await this.lockManager.lockJobCreation(ctx);
        } catch (err) {
            ctx.logger.warn(`[JobManager] Error obtaining lock for creating jobs`, { err });
            return;
        }

        try {
            if (!(await this.instanceGroupManager.isGroupJobsCreationAllowed(ctx))) {
                ctx.logger.info('[JobManager] Wait before allowing job creation');
                return;
            }

            const instanceGroupNames = await this.instanceGroupManager.getAllInstanceGroupNames(ctx);
            await this.createJobs(
                ctx,
                instanceGroupNames,
                this.jobQueue,
                JobType.Autoscale,
                this.autoscalerProcessingTimeoutMs,
            );
            await this.createJobs(
                ctx,
                instanceGroupNames,
                this.jobQueue,
                JobType.Launch,
                this.launcherProcessingTimeoutMs,
            );

            // populate some queue health metrics
            const healthCheckResult = await this.jobQueue.checkHealth();
            await this.metricsLoop.saveMetricQueueWaiting(healthCheckResult.waiting);
            await this.instanceGroupManager.setGroupJobsCreationGracePeriod(ctx);
        } catch (err) {
            ctx.logger.error(`[JobManager] Error while creating jobs for group ${err}`);
            jobCreateFailureCounter.inc();
        } finally {
            await lock.release();
        }
    }

    async createJobs(
        ctx: context.Context,
        instanceGroupNames: string[],
        jobQueue: Queue,
        jobType: JobType,
        processingTimeoutMillis: number,
    ): Promise<void> {
        instanceGroupNames.forEach((instanceGroupName) => {
            ctx.logger.info(`[JobManager] Creating ${jobType} job for group ${instanceGroupName}`);

            const jobData: JobData = {
                groupName: instanceGroupName,
                type: jobType,
            };

            jobCreateTotalCounter.inc({ type: jobData.type });
            const newJob = jobQueue.createJob(jobData);
            newJob
                .timeout(processingTimeoutMillis)
                .retries(0)
                .save()
                .then((job) => {
                    ctx.logger.info(`[JobManager] Job created ${jobType}:${job.id} for group ${jobData.groupName}`);
                })
                .catch((error) => {
                    ctx.logger.info(
                        `[JobManager] Error while creating ${jobType} job for group ${instanceGroupName}: ${error}`,
                    );
                    jobCreateFailureCounter.inc({ type: jobData.type });
                });
        });
    }
}
