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

const groupsManaged = new promClient.Gauge({
    name: 'autoscaling_groups_managed',
    help: 'Gauge for groups currently being managed',
});

export enum JobType {
    Autoscale = 'AUTOSCALE',
    Launch = 'LAUNCH',
    Sanity = 'SANITY',
}

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
        });
        newQueue.on('failed', (job, err) => {
            logger.error(
                `[QueueProcessor] Failed processing job ${job.data.type}:${job.id} with error message ${err.message}`,
                { err },
            );
        });
        newQueue.on('stalled', (jobId) => {
            logger.error(`[QueueProcessor] Stalled job ${jobId}; will be reprocessed`);
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
                    logger.warn(`[QueueProcessor] Unknown job type ${job.data.type}:${job.id}`);
            }
        });
        return newQueue;
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
            await this.createJobs(
                ctx,
                instanceGroups,
                this.jobQueue,
                JobType.Launch,
                this.launcherProcessingTimeoutMs,
            );

            await this.instanceGroupManager.setGroupJobsCreationGracePeriod();
        } catch (err) {
            ctx.logger.error(`[JobManager] Error while creating jobs for group ${err}`);
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
                });
        });
    }
}
