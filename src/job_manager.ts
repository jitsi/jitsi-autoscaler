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

export interface JobManagerOptions {
    queueRedisOptions: ClientOpts;
    lockManager: LockManager;
    instanceGroupManager: InstanceGroupManager;
    instanceLauncher: InstanceLauncher;
    autoscaler: AutoscaleProcessor;
    autoscalerProcessingTimeoutMilli: number;
    launcherProcessingTimeoutMilli: number;
}

const groupsManaged = new promClient.Gauge({
    name: 'autoscaling_groups_managed',
    help: 'Gauge for groups currently being managed',
});

export interface JobData {
    groupName: string;
}

export default class JobManager {
    private static readonly autoscalerQueueName = 'AutoscalerJobs';
    private static readonly launcherQueueName = 'LauncherJobs';

    private lockManager: LockManager;
    private instanceGroupManager: InstanceGroupManager;
    private instanceLauncher: InstanceLauncher;
    private autoscaler: AutoscaleProcessor;
    private autoscalerQueue: Queue;
    private launcherQueue: Queue;
    private autoscalerProcessingTimeoutMilli: number;
    private launcherProcessingTimeoutMilli: number;

    constructor(options: JobManagerOptions) {
        this.lockManager = options.lockManager;
        this.instanceGroupManager = options.instanceGroupManager;
        this.instanceLauncher = options.instanceLauncher;
        this.autoscaler = options.autoscaler;
        this.autoscalerProcessingTimeoutMilli = options.autoscalerProcessingTimeoutMilli;
        this.launcherProcessingTimeoutMilli = options.launcherProcessingTimeoutMilli;

        this.autoscalerQueue = this.createQueue(
            JobManager.autoscalerQueueName,
            options.queueRedisOptions,
            (ctx, group) => this.autoscaler.processAutoscalingByGroup(ctx, group),
        );
        this.launcherQueue = this.createQueue(JobManager.launcherQueueName, options.queueRedisOptions, (ctx, group) =>
            this.instanceLauncher.launchOrShutdownInstancesByGroup(ctx, group),
        );
    }

    createQueue(
        queueName: string,
        redisClientOptions: ClientOpts,
        processingHandler: (ctx: context.Context, groupName: string) => Promise<boolean>,
    ): Queue {
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
                `[QueueProcessor] Failed processing job ${queueName}:${job.id} with error message ${err.message}`,
                { err },
            );
        });
        newQueue.on('stalled', (jobId) => {
            logger.error(`[QueueProcessor] Stalled job ${queueName}:${jobId}; will be reprocessed`);
        });

        newQueue.process((job: Job, done: DoneCallback<boolean>) => {
            const start = Date.now();
            const pollId = shortid.generate();
            const pollLogger = logger.child({
                id: pollId,
            });
            const ctx = new context.Context(pollLogger, start, pollId);
            const jobData: JobData = job.data;

            ctx.logger.info(
                `[QueueProcessor] Start processing job ${queueName}:${job.id} for group ${jobData.groupName}`,
            );

            processingHandler(ctx, jobData.groupName)
                .then((result: boolean) => {
                    ctx.logger.info(
                        `[QueueProcessor] Done processing job ${queueName}:${job.id} for group ${jobData.groupName}`,
                    );
                    return done(null, result);
                })
                .catch((error) => {
                    ctx.logger.info(
                        `[QueueProcessor] Error processing job ${queueName}:${job.id} for group ${jobData.groupName}: ${error}`,
                        {
                            jobId: job.id,
                            jobData: jobData,
                        },
                    );
                    return done(error, false);
                });
        });

        return newQueue;
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
            await this.createJobs(ctx, instanceGroups, this.autoscalerQueue, this.autoscalerProcessingTimeoutMilli);
            await this.createJobs(ctx, instanceGroups, this.launcherQueue, this.launcherProcessingTimeoutMilli);

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
        processingTimeoutMillis: number,
    ): Promise<void> {
        instanceGroups.forEach((instanceGroup) => {
            ctx.logger.info(`[JobManager] Creating jobs in queue ${jobQueue.name} for group ${instanceGroup.name}`);

            const jobData: JobData = {
                groupName: instanceGroup.name,
            };
            const newJob = jobQueue.createJob(jobData);
            newJob
                .timeout(processingTimeoutMillis)
                .retries(0)
                .save()
                .then((job) => {
                    ctx.logger.info(
                        `[JobManager] Job created ${jobQueue.name}:${job.id} for group ${jobData.groupName}`,
                    );
                })
                .catch((error) => {
                    ctx.logger.info(
                        `[JobManager] Error while creating job in queue ${jobQueue.name} for group ${instanceGroup.name}: ${error}`,
                    );
                });
        });
    }
}
