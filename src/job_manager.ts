import Queue, { DoneCallback, Job } from 'bee-queue';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import * as context from './context';
import shortid from 'shortid';
import logger from './logger';
import { ClientOpts } from 'redis';
import InstanceLauncher from './instance_launcher';
import AutoscaleProcessor from './autoscaler';
import LockManager from './lock_manager';
import Redlock from 'redlock';
import * as promClient from 'prom-client';
import SanityLoop from './sanity_loop';

export interface JobManagerOptions {
    queueRedisOptions: ClientOpts;
    lockManager: LockManager;
    instanceGroupManager: InstanceGroupManager;
    instanceLauncher: InstanceLauncher;
    autoscaler: AutoscaleProcessor;
    sanityLoop: SanityLoop;
    autoscalerProcessingTimeoutMs: number;
    launcherProcessingTimeoutMs: number;
    sanityLoopProcessingTimeoutMs: number;
}

export enum JobType {
    Autoscale = 'AUTOSCALE',
    Launch = 'LAUNCH',
    Sanity = 'SANITY',
}

const groupsManaged = new promClient.Gauge({
    name: 'autoscaling_groups_managed',
    help: 'Gauge for groups currently being managed',
});

const jobCreateFailureCounter = new promClient.Counter({
    name: 'job_create_failure_total',
    help: 'Counter for jobs failed to create',
    labelNames: ['type'],
});
jobCreateFailureCounter.labels(JobType.Autoscale).inc(0);
jobCreateFailureCounter.labels(JobType.Launch).inc(0);
jobCreateFailureCounter.labels(JobType.Sanity).inc(0);

const jobCreateTotalCounter = new promClient.Counter({
    name: 'job_create_total',
    help: 'Counter for total job create operations',
    labelNames: ['type'],
});
jobCreateTotalCounter.labels(JobType.Autoscale).inc(0);
jobCreateTotalCounter.labels(JobType.Launch).inc(0);
jobCreateTotalCounter.labels(JobType.Sanity).inc(0);

const jobProcessFailureCounter = new promClient.Counter({
    name: 'job_process_failure_total',
    help: 'Counter for jobs processing failures',
    labelNames: ['type'],
});
jobProcessFailureCounter.labels(JobType.Autoscale).inc(0);
jobProcessFailureCounter.labels(JobType.Launch).inc(0);
jobProcessFailureCounter.labels(JobType.Sanity).inc(0);

const jobProcessTotalCounter = new promClient.Counter({
    name: 'job_process_total',
    help: 'Counter for total jobs processed',
    labelNames: ['type'],
});
jobProcessTotalCounter.labels(JobType.Autoscale).inc(0);
jobProcessTotalCounter.labels(JobType.Launch).inc(0);
jobProcessTotalCounter.labels(JobType.Sanity).inc(0);

const queueErrorCounter = new promClient.Counter({
    name: 'queue_error_total',
    help: 'Counter for queue errors',
});

const queueStalledCounter = new promClient.Counter({
    name: 'queue_stalled_total',
    help: 'Counter for stalled job events',
});

const queueWaiting = new promClient.Gauge({
    name: 'queue_waiting',
    help: 'Gauge for current jobs waiting to be processed',
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
    private jobQueue: Queue;
    private autoscalerProcessingTimeoutMs: number;
    private launcherProcessingTimeoutMs: number;
    private sanityLoopProcessingTimeoutMs: number;

    constructor(options: JobManagerOptions) {
        this.lockManager = options.lockManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.instanceLauncher = options.instanceLauncher;
        this.autoscaler = options.autoscaler;
        this.sanityLoop = options.sanityLoop;
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
            logger.error(`[QueueProcessor] A queue error happened in queue ${queueName}: ${err.message}`, { err });
            queueErrorCounter.inc();
        });
        newQueue.on('failed', (job, err) => {
            logger.error(
                `[QueueProcessor] Failed processing job ${job.data.type}:${job.id} with error message ${err.message}`,
                { err },
            );
            const jobData: JobData = job.data;
            jobProcessTotalCounter.inc({ type: jobData.type });
            jobProcessFailureCounter.inc({ type: jobData.type });
        });
        newQueue.on('stalled', (jobId) => {
            logger.error(`[QueueProcessor] Stalled job ${jobId}; will be reprocessed`);
            queueStalledCounter.inc();
        });

        newQueue.process((job: Job, done: DoneCallback<boolean>) => {
            switch (job.data.type) {
                case JobType.Autoscale:
                    this.processJob(job, (ctx, group) => this.autoscaler.processAutoscalingByGroup(ctx, group), done);
                    break;
                case JobType.Launch:
                    this.processJob(
                        job,
                        (ctx, group) => this.instanceLauncher.launchOrShutdownInstancesByGroup(ctx, group),
                        done,
                    );
                    break;
                case JobType.Sanity:
                    this.processJob(job, (ctx, group) => this.sanityLoop.reportUntrackedInstances(ctx, group), done);
                    break;
                default:
                    this.processJob(job, () => this.handleUnknownJobType(), done);
            }
        });
        return newQueue;
    }

    async handleUnknownJobType(): Promise<boolean> {
        throw new Error('Unkown job type');
    }

    processJob(
        job: Job,
        processingHandler: (ctx: context.Context, groupName: string) => Promise<boolean>,
        done: DoneCallback<boolean>,
    ): void {
        const start = Date.now();
        const pollId = shortid.generate();
        const pollLogger = logger.child({
            id: pollId,
        });
        const ctx = new context.Context(pollLogger, start, pollId);
        const jobData: JobData = job.data;
        ctx.logger.info(
            `[QueueProcessor] Start processing job ${jobData.type}:${job.id} for group ${jobData.groupName}`,
        );

        processingHandler(ctx, jobData.groupName)
            .then((result: boolean) => {
                ctx.logger.info(
                    `[QueueProcessor] Done processing job ${jobData.type}:${job.id} for group ${jobData.groupName}`,
                );
                jobProcessTotalCounter.inc({ type: jobData.type });
                return done(null, result);
            })
            .catch((error) => {
                ctx.logger.info(
                    `[QueueProcessor] Error processing job ${jobData.type}:${job.id} for group ${jobData.groupName}: ${error}`,
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
        if (!(await this.instanceGroupManager.isSanityJobsCreationAllowed())) {
            ctx.logger.info('[JobManager] Wait before allowing sanity job creation');
            return;
        }

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockJobCreation(ctx);
        } catch (err) {
            ctx.logger.warn(`[JobManager] Error obtaining lock for creating sanity jobs`, { err });
            return;
        }

        try {
            if (!(await this.instanceGroupManager.isSanityJobsCreationAllowed())) {
                ctx.logger.info('[JobManager] Wait before allowing sanity job creation');
                return;
            }

            const instanceGroups = await this.instanceGroupManager.getAllInstanceGroups(ctx);
            groupsManaged.set(instanceGroups.length);

            await this.createJobs(
                ctx,
                instanceGroups,
                this.jobQueue,
                JobType.Sanity,
                this.sanityLoopProcessingTimeoutMs,
            );

            await this.instanceGroupManager.setSanityJobsCreationGracePeriod();
        } catch (err) {
            ctx.logger.error(`[JobManager] Error while creating sanity jobs for group ${err}`);
            jobCreateFailureCounter.inc({ type: JobType.Sanity });
        } finally {
            lock.unlock();
        }
    }

    async createGroupProcessingJobs(ctx: context.Context): Promise<void> {
        if (!(await this.instanceGroupManager.isGroupJobsCreationAllowed())) {
            ctx.logger.info('[JobManager] Wait before allowing job creation');
            return;
        }

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockJobCreation(ctx);
        } catch (err) {
            ctx.logger.warn(`[JobManager] Error obtaining lock for creating jobs`, { err });
            return;
        }

        try {
            if (!(await this.instanceGroupManager.isGroupJobsCreationAllowed())) {
                ctx.logger.info('[JobManager] Wait before allowing job creation');
                return;
            }

            const instanceGroups = await this.instanceGroupManager.getAllInstanceGroups(ctx);
            groupsManaged.set(instanceGroups.length);
            await this.createJobs(
                ctx,
                instanceGroups,
                this.jobQueue,
                JobType.Autoscale,
                this.autoscalerProcessingTimeoutMs,
            );
            await this.createJobs(ctx, instanceGroups, this.jobQueue, JobType.Launch, this.launcherProcessingTimeoutMs);

            // populate some queue health metrics
            const healthCheckResult = await this.jobQueue.checkHealth();
            queueWaiting.set(healthCheckResult.waiting);

            await this.instanceGroupManager.setGroupJobsCreationGracePeriod();
        } catch (err) {
            ctx.logger.error(`[JobManager] Error while creating jobs for group ${err}`);
            jobCreateFailureCounter.inc();
        } finally {
            lock.unlock();
        }
    }

    async createJobs(
        ctx: context.Context,
        instanceGroups: Array<InstanceGroup>,
        jobQueue: Queue,
        jobType: JobType,
        processingTimeoutMillis: number,
    ): Promise<void> {
        instanceGroups.forEach((instanceGroup) => {
            ctx.logger.info(`[JobManager] Creating ${jobType} job for group ${instanceGroup.name}`);

            const jobData: JobData = {
                groupName: instanceGroup.name,
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
                        `[JobManager] Error while creating ${jobType} job for group ${instanceGroup.name}: ${error}`,
                    );
                    jobCreateFailureCounter.inc({ type: jobData.type });
                });
        });
    }
}
