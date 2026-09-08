import './polyfills';
import config from './config';
import express from 'express';
import * as context from './context';
import Consul from 'consul';
import Handlers from './handlers';
import Validator from './validator';
import Redis, { RedisOptions } from 'ioredis';
import * as promClient from 'prom-client';
import AutoscalerLogger from './logger';
import { nanoid } from 'nanoid/non-secure';
import { ASAPPubKeyFetcher } from './asap';
import { expressjwt } from 'express-jwt';
import { InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import InstanceGroupManager, { SUPPORTED_INSTANCE_TYPES } from './instance_group';
import AutoscaleProcessor from './autoscaler';
import InstanceLauncher from './instance_launcher';
import { RedisLockManager, ConsulLockManager } from './lock_manager';
import * as stats from './stats';
import ShutdownManager from './shutdown_manager';
import ReconfigureManager from './reconfigure_manager';
import JobManager from './job_manager';
import GroupReportGenerator from './group_report';
import Audit from './audit';
import { body, param, validationResult } from 'express-validator';
import SanityLoop from './sanity_loop';
import MetricsLoop from './metrics_loop';
import ScalingManager from './scaling_options_manager';
import ScheduledScalingProcessor from './scheduled_scaling_processor';
import RedisStore from './redis';
import ConsulStore from './consul';
import PrometheusClient from './prometheus';
import MetricsStore from './metrics_store';
import InstanceStore from './instance_store';
import { AutoscalerLockManager } from './lock';
import ReservationManager from './reservation_manager';
import SeleniumGridClient from './selenium_grid_client';
import { ReservationStore } from './reservation_store';

//import { RequestTracker, RecorderRequestMeta } from './request_tracker';
//import * as meet from './meet_processor';

//const jwtSigningKey = fs.readFileSync(meet.TokenSigningKeyFile);

const asLogger = new AutoscalerLogger({ logLevel: config.LogLevel });
const logger = asLogger.createLogger(config.LogLevel);

process.on('unhandledRejection', (reason, promise) => {
    logger.error('[Process] Unhandled promise rejection', { reason, promise });
});

let shuttingDown = false;
let jobsStarted = false;
let groupJobsTimeout: NodeJS.Timeout;
let sanityJobsTimeout: NodeJS.Timeout;
let metricsTimeout: NodeJS.Timeout;

// metrics listener
const mapp = express();

const app = express();
app.use(express.json());

// TODO: unittesting
// TODO: readme updates and docker compose allthethings

const consulClient = new Consul({
    host: config.ConsulHost,
    port: config.ConsulPort,
    secure: config.ConsulSecure,
});

const redisOptions = <RedisOptions>{
    host: config.RedisHost,
    port: config.RedisPort,
    retryStrategy(times: number) {
        const delay = Math.min(times * 1000, 30000);
        logger.info(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
    },
    maxRetriesPerRequest: null,
};

if (config.RedisPassword) {
    redisOptions.password = config.RedisPassword;
}

if (config.RedisTLS) {
    redisOptions.tls = {};
}

if (config.RedisDb) {
    redisOptions.db = config.RedisDb;
}

const redisClient = new Redis(redisOptions);
redisClient.on('error', (err) => {
    logger.error('[Redis] Connection error', { err });
});
redisClient.on('connect', () => {
    logger.info('[Redis] Connected');
});
redisClient.on('ready', () => {
    logger.info('[Redis] Ready');
});

let metricsStore: MetricsStore;

switch (config.MetricsStoreProvider) {
    case 'prometheus':
        metricsStore = new PrometheusClient({
            endpoint: config.PrometheusURL,
        });
        break;
    default:
        // redis
        metricsStore = new RedisStore({
            redisClient,
            redisScanCount: config.RedisScanCount,
            idleTTL: config.IdleTTL,
            metricTTL: config.MetricTTL,
            provisioningTTL: config.ProvisioningTTL,
            shutdownStatusTTL: config.ShutdownStatusTTL,
            groupRelatedDataTTL: config.GroupRelatedDataTTL,
            serviceLevelMetricsTTL: config.ServiceLevelMetricsTTL,
        });
        break;
}

let instanceStore: InstanceStore;

switch (config.InstanceStoreProvider) {
    case 'consul':
        instanceStore = new ConsulStore({
            client: consulClient,
            idleTTL: config.IdleTTL,
            provisioningTTL: config.ProvisioningTTL,
            shutdownStatusTTL: config.ShutdownStatusTTL,
        });
        break;
    default:
        // redis
        instanceStore = new RedisStore({
            redisClient,
            redisScanCount: config.RedisScanCount,
            idleTTL: config.IdleTTL,
            metricTTL: config.MetricTTL,
            provisioningTTL: config.ProvisioningTTL,
            shutdownStatusTTL: config.ShutdownStatusTTL,
            groupRelatedDataTTL: config.GroupRelatedDataTTL,
            serviceLevelMetricsTTL: config.ServiceLevelMetricsTTL,
        });
        break;
}

// Upper bound on how long the deep health check waits on the store/queue probes before
// reporting unhealthy, so a hung backend cannot hang the probe itself.
const DEEP_HEALTH_TIMEOUT_MS = 5000;

interface DeepHealthDetails {
    instanceStore: boolean;
    jobQueue: boolean;
    jobsStarted: boolean;
    timedOut?: boolean;
}

async function deepHealthChecks(ctx: context.Context): Promise<DeepHealthDetails> {
    const [storeHealthy, queueHealthy] = await Promise.all([instanceStore.ping(ctx), jobManager.isHealthy()]);
    return { instanceStore: !!storeHealthy, jobQueue: !!queueHealthy, jobsStarted };
}

function deepHealthTimeout(ms: number): Promise<DeepHealthDetails> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ instanceStore: false, jobQueue: false, jobsStarted, timedOut: true }), ms);
        t.unref();
    });
}

mapp.use(context.injectContext);
mapp.get('/health', async (req: express.Request, res: express.Response) => {
    try {
        logger.debug('Health check');
        if (shuttingDown) {
            res.status(503).send('shutting down');
            return;
        }
        if (redisClient.status !== 'ready') {
            logger.warn('Health check failed: redis not ready', { redis: redisClient.status });
            res.status(503).json({ status: 'unhealthy', redis: redisClient.status });
            return;
        }
        if (req.query['deep']) {
            const details = await Promise.race([
                deepHealthChecks(req.context),
                deepHealthTimeout(DEEP_HEALTH_TIMEOUT_MS),
            ]);

            if (!details.instanceStore || !details.jobQueue || !details.jobsStarted) {
                logger.warn('Deep health check failed', details);
                res.status(500).json({ status: 'unhealthy', ...details });
            } else {
                res.send('deeply healthy');
            }
        } else {
            res.send('healthy!');
        }
    } catch (err) {
        logger.error('Health check error', { err });
        res.status(500).json({ status: 'unhealthy', error: `${err}` });
    }
});

const audit = new Audit({
    redisClient,
    redisScanCount: config.RedisScanCount,
    auditTTL: config.AuditTTL,
    groupRelatedDataTTL: config.GroupRelatedDataTTL,
});

const shutdownManager = new ShutdownManager({
    instanceStore,
    shutdownTTL: config.ShutDownTTL,
    audit,
});

const reconfigureManager = new ReconfigureManager({
    instanceStore,
    reconfigureTTL: config.ReconfigureTTL,
    audit,
});

const instanceTracker = new InstanceTracker({
    metricsStore,
    instanceStore,
    shutdownManager,
    audit,
});

const cloudManager = new CloudManager({
    shutdownManager,
    isDryRun: config.DryRun,
    ociConfigurationFilePath: config.OciConfigurationFilePath,
    ociConfigurationProfile: config.OciConfigurationProfile,
    digitalOceanAPIToken: config.DigitalOceanAPIToken,
    digitalOceanConfigurationFilePath: config.DigitalOceanConfigurationFilePath,
    instanceTracker,
    audit,
    cloudProviders: config.CloudProviders,
    customConfigurationLaunchScriptPath: config.CustomConfigurationLaunchScriptPath,
    customConfigurationLaunchScriptTimeoutMs: config.CustomConfigurationLaunchScriptTimeoutMs,
    customConfigurationListScriptPath: config.CustomConfigurationListScriptPath,
    cloudProviderRequestTimeoutMs: config.CloudProviderRequestTimeoutMs,
});

let lockManager: AutoscalerLockManager;

if (config.LockProvider === 'consul') {
    lockManager = new ConsulLockManager({
        consulClient,
        jobCreationLockTTL: config.JobsCreationLockTTLMs,
        groupLockTTLMs: config.GroupLockTTLMs,
        logger,
    });
} else {
    lockManager = new RedisLockManager(logger, {
        redisClient,
        jobCreationLockTTL: config.JobsCreationLockTTLMs,
        groupLockTTLMs: config.GroupLockTTLMs,
    });
}

// Reservation store uses the same backend as the instance store
const reservationStore: ReservationStore = instanceStore as unknown as ReservationStore;

const reservationManager = new ReservationManager({
    reservationStore,
    defaultTTLSec: config.ReservationDefaultTTLSec,
    scaleDownGraceSec: config.ReservationScaleDownGraceSec,
    expiryLookaheadSec: config.ReservationExpiryLookaheadSec,
});

const seleniumGridClient = new SeleniumGridClient({
    fetchTimeoutMs: config.SeleniumGridFetchTimeoutMs,
});

const instanceGroupManager = new InstanceGroupManager({
    instanceStore,
    initialGroupList: config.GroupList,
    groupJobsCreationGracePeriod: config.GroupJobsCreationGracePeriodSec,
    sanityJobsCreationGracePeriod: config.SanityJobsCreationGracePeriodSec,
});

logger.info('Starting up autoscaler service with config', { config });

logger.info('Initializing instance group manager...');
const start = Date.now();
const initId = nanoid(10);
const initLogger = logger.child({ id: initId });
const initCtx = new context.Context(initLogger, start, initId);
instanceGroupManager.init(initCtx).catch((err) => {
    logger.info('Failed initializing list of groups', { err });
});

const metricsLoop = new MetricsLoop({
    redisClient: redisClient,
    metricsTTL: config.ServiceLevelMetricsTTL,
    instanceGroupManager: instanceGroupManager,
    instanceTracker: instanceTracker,
    instanceStore,
    metricsStore,
    ctx: initCtx,
});

const autoscaleProcessor = new AutoscaleProcessor({
    instanceTracker,
    instanceGroupManager,
    lockManager,
    audit,
    cloudManager,
    cloudRetryStrategy: {
        maxTimeInSeconds: config.ReportExtCallMaxTimeInSeconds,
        maxDelayInSeconds: config.ReportExtCallMaxDelayInSeconds,
        retryableStatusCodes: config.ReportExtCallRetryableStatusCodes,
    },
    defaultCloudGuardGraceCount: config.CloudGuardGraceCount,
    cloudGuardEnabled: config.CloudGuardEnabled,
    metricsLoop,
    defaultTimezone: config.ScheduledScalingDefaultTimezone,
    reservationManager,
    seleniumGridClient,
});

const scheduledScalingProcessor = new ScheduledScalingProcessor({
    instanceGroupManager,
    lockManager,
    audit,
    defaultTimezone: config.ScheduledScalingDefaultTimezone,
    enabled: config.ScheduledScalingEnabled,
});

const instanceLauncher = new InstanceLauncher({
    maxThrottleThreshold: config.MaxThrottleThreshold,
    instanceTracker,
    cloudManager,
    instanceGroupManager,
    lockManager,
    shutdownManager,
    audit,
    metricsLoop,
    cloudRetryStrategy: {
        maxTimeInSeconds: config.ReportExtCallMaxTimeInSeconds,
        maxDelayInSeconds: config.ReportExtCallMaxDelayInSeconds,
        retryableStatusCodes: config.ReportExtCallRetryableStatusCodes,
    },
    defaultCloudGuardGraceCount: config.CloudGuardGraceCount,
    cloudGuardEnabled: config.CloudGuardEnabled,
});

const groupReportGenerator = new GroupReportGenerator({
    instanceTracker,
    shutdownManager,
    reconfigureManager,
    metricsLoop,
});

const sanityLoop = new SanityLoop({
    metricsStore,
    instanceStore,
    cloudManager,
    reportExtCallRetryStrategy: {
        maxTimeInSeconds: config.ReportExtCallMaxTimeInSeconds,
        maxDelayInSeconds: config.ReportExtCallMaxDelayInSeconds,
        retryableStatusCodes: config.ReportExtCallRetryableStatusCodes,
    },
    groupReportGenerator,
    instanceGroupManager,
});

// Each Queue in JobManager has its own Redis connection (other than the one in RedisClient)
// Bee-Queue also uses different a Redis library, so we map redisOptions to the object expected by Bee-Queue
const jobManager = new JobManager({
    logger,
    queueRedisOptions: {
        host: config.RedisHost,
        port: config.RedisPort,
        password: config.RedisPassword ? config.RedisPassword : undefined,
        db: config.RedisDb ? config.RedisDb : undefined,
        tls: config.RedisTLS ? {} : undefined,
    },
    lockManager,
    instanceGroupManager,
    instanceLauncher,
    autoscaler: autoscaleProcessor,
    scheduledScalingProcessor,
    sanityLoop,
    metricsLoop,
    autoscalerProcessingTimeoutMs: config.GroupProcessingTimeoutMs,
    launcherProcessingTimeoutMs: config.GroupProcessingTimeoutMs,
    sanityLoopProcessingTimeoutMs: config.SanityProcessingTimoutMs,
    jobsConcurrency: config.JobsConcurrency,
});

const scalingManager = new ScalingManager({
    lockManager: lockManager,
    instanceGroupManager: instanceGroupManager,
});

async function startProcessingGroups() {
    logger.info('Start pooling..');

    await createGroupProcessingJobs();
}
logger.info(`Waiting ${config.InitialWaitForPooling}ms before starting to loop for group processing`);
groupJobsTimeout = setTimeout(startProcessingGroups, config.InitialWaitForPooling);

const groupProcessingErrorCounter = new promClient.Counter({
    name: 'autoscaler_group_processing_errors',
    help: 'Counter for high level group processing errors',
});

async function createGroupProcessingJobs() {
    const start = Date.now();
    const pollId = nanoid(10);
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    try {
        await jobManager.createGroupProcessingJobs(ctx);
        if (!jobsStarted) {
            jobsStarted = true;
            logger.info('[Process] Job creation loop started successfully');
        }
    } catch (err) {
        ctx.logger.error(`Error while creating group processing jobs`, { err });
        // should increment some group processing error counter here
        groupProcessingErrorCounter.inc();
    }
    if (!shuttingDown) {
        groupJobsTimeout = setTimeout(createGroupProcessingJobs, config.GroupJobsCreationIntervalSec * 1000);
    }
}

sanityJobsTimeout = setTimeout(createSanityProcessingJobs, 0);

async function createSanityProcessingJobs() {
    const start = Date.now();
    const pollId = nanoid(10);
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    try {
        await jobManager.createSanityProcessingJobs(ctx);
    } catch (err) {
        ctx.logger.error(`Error while creating sanity processing jobs`, { err });
    }
    if (!shuttingDown) {
        sanityJobsTimeout = setTimeout(createSanityProcessingJobs, config.SanityJobsCreationIntervalSec * 1000);
    }
}

const asapFetcher = new ASAPPubKeyFetcher(config.AsapPubKeyBaseUrl, config.AsapPubKeyTTL);

metricsTimeout = setTimeout(() => pollForMetrics(metricsLoop), 0);

async function pollForMetrics(metricsLoop: MetricsLoop) {
    try {
        await metricsLoop.updateMetrics();
    } catch (err) {
        logger.error('[MetricsLoop] Error in metrics poll', { err });
    }
    if (!shuttingDown) {
        metricsTimeout = setTimeout(pollForMetrics.bind(null, metricsLoop), config.MetricsLoopIntervalMs);
    }
}

const validator = new Validator({ instanceTracker, instanceGroupManager, metricsLoop, shutdownManager });

const h = new Handlers({
    instanceTracker,
    instanceGroupManager,
    shutdownManager,
    cloudManager,
    reconfigureManager,
    groupReportGenerator,
    lockManager,
    audit,
    scalingManager,
    defaultTimezone: config.ScheduledScalingDefaultTimezone,
    reservationManager,
    validator,
});

const loggedPaths = ['/sidecar*', '/groups*'];
app.use(loggedPaths, stats.middleware);
app.use('/', context.injectContext);
app.use(loggedPaths, context.accessLogger);
stats.registerHandler(mapp, '/metrics');
app.use(
    expressjwt({
        secret: asapFetcher.secretCallback,
        audience: config.AsapJwtAcceptedAud,
        issuer: config.AsapJwtAcceptedHookIss,
        algorithms: ['RS256'],
    }).unless(() => {
        return !config.ProtectedApi;
    }),
);

// Route-scoped authorization (optional). ASAP_JWT_SIDECAR_ISS is a comma-separated list of
// issuers whose tokens belong to sidecars. When it is set, tokens from those issuers may only
// call /sidecar* endpoints, and /sidecar* endpoints only accept tokens from those issuers, so a
// leaked sidecar token cannot manage groups and an operator token cannot spoof sidecar reports.
// When the variable is unset behaviour is unchanged: any accepted issuer may call anything.
function parseIssuerList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}
const sidecarIssuers = parseIssuerList(process.env.ASAP_JWT_SIDECAR_ISS);
if (config.ProtectedApi && sidecarIssuers.length > 0) {
    logger.info('Route-scoped authorization enabled for sidecar issuers', { sidecarIssuers });
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        const auth = (req as express.Request & { auth?: { iss?: string } }).auth;
        const iss = auth?.iss;
        const isSidecarToken = iss !== undefined && sidecarIssuers.includes(iss);
        if (req.path.startsWith('/groups') && isSidecarToken) {
            req.context.logger.info('sidecar issuer token rejected for groups endpoint', { iss, u: req.url });
            res.status(403).send({ errors: ['sidecar tokens may not access group endpoints'] });
            return;
        }
        if (req.path.startsWith('/sidecar') && !isSidecarToken) {
            req.context.logger.info('non-sidecar issuer token rejected for sidecar endpoint', { iss, u: req.url });
            res.status(403).send({ errors: ['only sidecar tokens may access sidecar endpoints'] });
            return;
        }
        next();
    });
}

// Group names are used as path params and as store key fragments: restrict them to a safe alphabet.
const GROUP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Shared middleware for every /groups/:name* route (other than PUT /groups/:name, which creates):
// 400 on a malformed name, 404 when the group does not exist.
async function requireGroupExists(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
        const name = req.params.name;
        if (typeof name !== 'string' || !GROUP_NAME_PATTERN.test(name)) {
            res.status(400).json({ errors: ['Invalid group name'] });
            return;
        }
        const group = await instanceGroupManager.getInstanceGroup(req.context, name);
        if (!group) {
            res.status(404).json({ errors: [`Group ${name} not found`] });
            return;
        }
        next();
    } catch (err) {
        next(err);
    }
}

if (config.ProtectedApi) {
    logger.debug('starting in protected api mode');
} else {
    logger.warn('starting in unprotected api mode');
}

app.post('/sidecar/poll', async (req, res, next) => {
    try {
        await h.sidecarPoll(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/sidecar/shutdown', async (req, res, next) => {
    try {
        await h.sidecarShutdown(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/sidecar/stats', async (req, res, next) => {
    try {
        await h.sidecarStats(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/sidecar/status', async (req, res, next) => {
    try {
        await h.sidecarStatus(req, res);
    } catch (err) {
        next(err);
    }
});

app.put(
    '/groups/:name',
    param('name').matches(GROUP_NAME_PATTERN).withMessage('Invalid group name'),
    body('name').isString().matches(GROUP_NAME_PATTERN).withMessage('Invalid group name'),
    body('scalingOptions.minDesired').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.maxDesired').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.desiredCount').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.scaleUpQuantity').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.scaleDownQuantity').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.scaleUpThreshold').isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.scaleDownThreshold').isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.scalePeriod').isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('scalingOptions.scaleUpPeriodsCount').isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('scalingOptions.scaleDownPeriodsCount').isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('scalingOptions.cloudGuardGraceCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.reservationScaleUpThreshold')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Value must be at least 1'),
    body('gracePeriodTTLSec').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('protectedTTLSec').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('scalingOptions').custom((value) => {
        if (!validator.groupHasValidDesiredValues(value.minDesired, value.maxDesired, value.desiredCount)) {
            throw new Error('Desired count must be between min and max; min cannot be grater than max');
        }
        return true;
    }),
    body('type').custom(async (value) => {
        if (!(await validator.supportedInstanceType(value))) {
            throw new Error(`Invalid type of instance: ${value}`);
        }
        return true;
    }),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.upsertInstanceGroup(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.put(
    '/groups/:name/desired',
    requireGroupExists,
    body('minDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('maxDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('desiredCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body().custom(async (value, { req }) => {
        if (!(await validator.groupHasValidDesiredInput(req.context, req.params.name, value))) {
            throw new Error('Desired count must be between min and max; min cannot be grater than max');
        }
        return true;
    }),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.updateDesiredCount(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.put(
    '/groups/:name/scaling-options',
    requireGroupExists,
    body('scaleUpQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scaleDownQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scaleUpThreshold').optional().isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('scaleDownThreshold').optional().isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('scalePeriod').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('scaleUpPeriodsCount').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('scaleDownPeriodsCount').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('gracePeriodTTLSec').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('cloudGuardGraceCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('reservationScaleUpThreshold').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.updateScalingOptions(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.put(
    '/groups/:name/scaling-activities',
    requireGroupExists,
    body('enableAutoScale').optional().isBoolean({ strict: true }).withMessage('Value must be a boolean'),
    body('enableLaunch').optional().isBoolean({ strict: true }).withMessage('Value must be a boolean'),
    body('enableScheduler').optional().isBoolean({ strict: true }).withMessage('Value must be a boolean'),
    body('enableUntrackedThrottle').optional().isBoolean({ strict: true }).withMessage('Value must be a boolean'),
    body('enableReconfiguration').optional().isBoolean({ strict: true }).withMessage('Value must be a boolean'),
    body('enableCloudGuard').optional().isBoolean({ strict: true }).withMessage('Value must be a boolean'),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.updateScalingActivities(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.put(
    '/groups/:name/scheduled-scaling',
    requireGroupExists,
    body('enabled').isBoolean().withMessage('enabled must be a boolean'),
    body('timezone').optional().isString().withMessage('timezone must be a string'),
    body('periods').isArray().withMessage('periods must be an array'),
    body('periods.*.name').isString().notEmpty().withMessage('Period name must be a non-empty string'),
    body('periods.*.dayOfWeek').isArray({ min: 1 }).withMessage('dayOfWeek must be a non-empty array'),
    body('periods.*.dayOfWeek.*').isInt({ min: 0, max: 6 }).withMessage('dayOfWeek values must be 0-6'),
    body('periods.*.startHour').isInt({ min: 0, max: 23 }).withMessage('startHour must be 0-23'),
    body('periods.*.startMinute').optional().isInt({ min: 0, max: 59 }).withMessage('startMinute must be 0-59'),
    body('periods.*.endHour').isInt({ min: 0, max: 23 }).withMessage('endHour must be 0-23'),
    body('periods.*.endMinute').optional().isInt({ min: 0, max: 59 }).withMessage('endMinute must be 0-59'),
    body('periods.*.priority').isNumeric().withMessage('priority must be a number'),
    body('periods.*.scalingOptions.minDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('periods.*.scalingOptions.maxDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('periods.*.scalingOptions.desiredCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('periods.*.scalingOptions.scaleUpQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('periods.*.scalingOptions.scaleDownQuantity')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Value must be positive'),
    body('periods.*.scalingOptions.scaleUpThreshold')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('Value must be positive'),
    body('periods.*.scalingOptions.scaleDownThreshold')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('Value must be positive'),
    body('periods.*.scalingOptions.scalePeriod').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('periods.*.scalingOptions.scaleUpPeriodsCount')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Value must be at least 1'),
    body('periods.*.scalingOptions.scaleDownPeriodsCount')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Value must be at least 1'),
    body('periods.*.scalingOptions.cloudGuardGraceCount')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Value must be positive'),
    body('periods.*.scalingOptions.reservationScaleUpThreshold')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Value must be at least 1'),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.updateScheduledScaling(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.get('/groups/:name/scheduled-scaling', requireGroupExists, async (req, res, next) => {
    try {
        await h.getScheduledScaling(req, res);
    } catch (err) {
        next(err);
    }
});

app.delete('/groups/:name/scheduled-scaling', requireGroupExists, async (req, res, next) => {
    try {
        await h.deleteScheduledScaling(req, res);
    } catch (err) {
        next(err);
    }
});

app.put(
    '/groups/:name/instance-configuration',
    requireGroupExists,
    body('instanceConfigurationId').isString(),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.updateInstanceConfiguration(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.get('/groups/:name/report', requireGroupExists, async (req, res, next) => {
    try {
        await h.getGroupReport(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name/instance-audit', requireGroupExists, async (req, res, next) => {
    try {
        await h.getInstanceAudit(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name/group-audit', requireGroupExists, async (req, res, next) => {
    try {
        await h.getGroupAudit(req, res);
    } catch (err) {
        next(err);
    }
});

// Reservation endpoints for selenium-grid groups
app.post(
    '/groups/:name/reservations',
    requireGroupExists,
    body('nodeCount').isInt({ min: 1 }),
    body('ttlSeconds').optional().isInt({ min: 1 }),
    async (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            res.status(422).json({ errors: errors.array() });
            return;
        }
        try {
            await h.createReservation(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.get('/groups/:name/reservations', requireGroupExists, async (req, res, next) => {
    try {
        await h.listReservations(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name/reservations/:id', requireGroupExists, async (req, res, next) => {
    try {
        await h.getReservation(req, res);
    } catch (err) {
        next(err);
    }
});

app.put(
    '/groups/:name/reservations/:id',
    requireGroupExists,
    body('ttlSeconds').isInt({ min: 1 }),
    async (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            res.status(422).json({ errors: errors.array() });
            return;
        }
        try {
            await h.extendReservation(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.delete('/groups/:name/reservations/:id', requireGroupExists, async (req, res, next) => {
    try {
        await h.deleteReservation(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups', async (req, res, next) => {
    try {
        await h.getInstanceGroups(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name', requireGroupExists, async (req, res, next) => {
    try {
        await h.getInstanceGroup(req, res);
    } catch (err) {
        next(err);
    }
});

app.delete(
    '/groups/:name',
    requireGroupExists,
    // Fast-fail pre-check; the handler re-checks under the group lock and answers 409.
    param('name').custom(async (value, { req }) => {
        if (await validator.groupHasActiveInstances((<express.Request>req).context, value)) {
            throw new Error('This group has active instances');
        }
        return true;
    }),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.deleteInstanceGroup(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.post('/groups/actions/reset', async (req, res, next) => {
    try {
        await h.resetInstanceGroups(req, res);
    } catch (err) {
        next(err);
    }
});

app.post(
    '/groups/:name/actions/launch-protected',
    requireGroupExists,
    body('count').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('maxDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('protectedTTLSec').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('count').custom(async (value, { req }) => {
        if (!(await validator.canLaunchInstances(<express.Request>req, value))) {
            throw new Error(`Max desired value must be increased first if you want to launch ${value} new instances.`);
        }
        return true;
    }),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.launchProtectedInstanceGroup(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.put(
    '/groups/options/full-scaling',
    body('options.minDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.maxDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.desiredCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.scaleUpQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.scaleDownQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.scaleUpThreshold').optional().isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('options.scaleDownThreshold').optional().isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('options.scalePeriod').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('options.scaleUpPeriodsCount').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('options.scaleDownPeriodsCount').optional().isInt({ min: 1 }).withMessage('Value must be at least 1'),
    body('options.cloudGuardGraceCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('instanceType').custom(async (value) => {
        if (!(await validator.supportedInstanceType(value))) {
            throw new Error(`Instance type not supported. Use one of: ${SUPPORTED_INSTANCE_TYPES.join(', ')}`);
        }
        return true;
    }),
    body('direction').custom(async (value) => {
        if (!(await validator.supportedScalingDirection(value))) {
            throw new Error('Scaling direction not supported. Use up or down instead');
        }
        return true;
    }),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.updateFullScalingOptionsForGroups(req, res);
        } catch (err) {
            next(err);
        }
    },
);

app.post('/groups/:name/actions/reconfigure-instances', requireGroupExists, async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        await h.reconfigureInstanceGroup(req, res);
    } catch (err) {
        next(err);
    }
});

// This is placed last in the middleware chain (after every route) and is our default error handler.
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    // If the headers have already been sent then we must use
    // the built-in default error handler according to
    // https://expressjs.com/en/guide/error-handling.html
    if (res.headersSent) {
        return next(err);
    }

    let l = logger;

    if (req.context && req.context.logger) {
        l = req.context.logger;
    }

    const httpErr = err as Error & { status?: number; statusCode?: number; type?: string };
    const status = httpErr.status ?? httpErr.statusCode;

    if (err.name === 'UnauthorizedError') {
        l.info(`unauthorized token ${err}`, { u: req.url });
        res.status(401).send('invalid token...');
    } else if (httpErr.type === 'entity.parse.failed' || (status >= 400 && status <= 499)) {
        // Client errors raised by body-parser and friends (malformed JSON, oversized payload, ...)
        l.info(`client error ${err}`, { u: req.url, status });
        res.status(status || 400).json({ errors: [err.message] });
    } else {
        l.error(`internal error ${err}`, { u: req.url, stack: err.stack });
        res.status(500).send('internal server error');
    }
});

const metricsServer = mapp.listen(config.MetricsServerPort, () => {
    logger.info(`...listening on :${config.MetricsServerPort}`);
});

const appServer = app.listen(config.HTTPServerPort, () => {
    logger.info(`...listening on :${config.HTTPServerPort}`);
});

async function gracefulShutdown(signal: string) {
    logger.info(`[Process] Received ${signal}, starting graceful shutdown`);
    shuttingDown = true;

    // Force exit after 45 seconds if graceful shutdown hangs
    setTimeout(() => {
        logger.error('[Process] Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, 45000).unref();

    // 1. Stop scheduling new jobs
    clearTimeout(groupJobsTimeout);
    clearTimeout(sanityJobsTimeout);
    clearTimeout(metricsTimeout);

    // 2. Stop accepting new requests
    await Promise.all([
        new Promise<void>((resolve) => appServer.close(() => resolve())),
        new Promise<void>((resolve) => metricsServer.close(() => resolve())),
    ]);
    logger.info('[Process] HTTP servers closed');

    // 3. Drain job queue (wait up to 30s for in-flight jobs)
    try {
        await jobManager.close(30000);
        logger.info('[Process] Job queue drained');
    } catch (err) {
        logger.error('[Process] Error draining job queue', { err });
    }

    // 4. Shut down lock manager
    try {
        if (lockManager.shutdown) {
            await lockManager.shutdown();
        }
        logger.info('[Process] Lock manager shut down');
    } catch (err) {
        logger.error('[Process] Error shutting down lock manager', { err });
    }

    // 5. Disconnect Redis
    try {
        await redisClient.quit();
        logger.info('[Process] Redis disconnected');
    } catch (err) {
        logger.error('[Process] Error disconnecting Redis', { err });
    }

    logger.info('[Process] Graceful shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
