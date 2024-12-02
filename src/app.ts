import config from './config';
import express from 'express';
import * as context from './context';
import Handlers from './handlers';
import Validator from './validator';
import Redis, { RedisOptions } from 'ioredis';
import * as promClient from 'prom-client';
import AutoscalerLogger from './logger';
import shortid from 'shortid';
import { ASAPPubKeyFetcher } from './asap';
import { expressjwt } from 'express-jwt';
import { InstanceTracker } from './instance_tracker';
import CloudManager from './cloud_manager';
import InstanceGroupManager from './instance_group';
import AutoscaleProcessor from './autoscaler';
import InstanceLauncher from './instance_launcher';
import LockManager from './lock_manager';
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
import RedisStore from './redis';
import PrometheusClient from './prometheus';
import MetricsStore from './metrics_store';
import InstanceStore from './instance_store';

//import { RequestTracker, RecorderRequestMeta } from './request_tracker';
//import * as meet from './meet_processor';

//const jwtSigningKey = fs.readFileSync(meet.TokenSigningKeyFile);

const asLogger = new AutoscalerLogger({ logLevel: config.LogLevel });
const logger = asLogger.createLogger(config.LogLevel);

// metrics listener
const mapp = express();

const app = express();
app.use(express.json());

// TODO: unittesting
// TODO: readme updates and docker compose allthethings

const redisOptions = <RedisOptions>{
    host: config.RedisHost,
    port: config.RedisPort,
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
    // case 'consul':
    //     instanceStore = new ConsulClient({
    //         logger,
    //         endpoint: config.ConsulURL,
    //     });
    //     break;
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

mapp.get('/health', (req: express.Request, res: express.Response) => {
    logger.debug('Health check');
    if (req.query['deep']) {
        redisClient.ping((err, reply) => {
            if (err) {
                res.status(500).send('unhealthy');
            } else {
                logger.debug('Redis ping reply', { reply });
                res.send('deeply healthy');
            }
        });
    } else {
        res.send('healthy!');
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
});

const lockManager: LockManager = new LockManager(logger, {
    redisClient,
    jobCreationLockTTL: config.JobsCreationLockTTLMs,
    groupLockTTLMs: config.GroupLockTTLMs,
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
const initId = shortid.generate();
const initLogger = logger.child({ id: initId });
const initCtx = new context.Context(initLogger, start, initId);
instanceGroupManager.init(initCtx).catch((err) => {
    logger.info('Failed initializing list of groups', { err });
});

const autoscaleProcessor = new AutoscaleProcessor({
    instanceTracker,
    instanceGroupManager,
    lockManager,
    audit,
});

const metricsLoop = new MetricsLoop({
    redisClient: redisClient,
    metricsTTL: config.ServiceLevelMetricsTTL,
    instanceGroupManager: instanceGroupManager,
    instanceTracker: instanceTracker,
    ctx: initCtx,
});

const instanceLauncher = new InstanceLauncher({
    maxThrottleThreshold: config.MaxThrottleThreshold,
    instanceTracker,
    cloudManager,
    instanceGroupManager,
    shutdownManager,
    audit,
    metricsLoop,
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
    sanityLoop,
    metricsLoop,
    autoscalerProcessingTimeoutMs: config.GroupProcessingTimeoutMs,
    launcherProcessingTimeoutMs: config.GroupProcessingTimeoutMs,
    sanityLoopProcessingTimeoutMs: config.SanityProcessingTimoutMs,
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
setTimeout(startProcessingGroups, config.InitialWaitForPooling);

const groupProcessingErrorCounter = new promClient.Counter({
    name: 'autoscaler_group_processing_errors',
    help: 'Counter for high level group processing errors',
});

async function createGroupProcessingJobs() {
    const start = Date.now();
    const pollId = shortid.generate();
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    try {
        await jobManager.createGroupProcessingJobs(ctx);
    } catch (err) {
        ctx.logger.error(`Error while creating group processing jobs`, { err });
        // should increment some group processing error counter here
        groupProcessingErrorCounter.inc();
    }
    setTimeout(createGroupProcessingJobs, config.GroupJobsCreationIntervalSec * 1000);
}

createSanityProcessingJobs();

async function createSanityProcessingJobs() {
    const start = Date.now();
    const pollId = shortid.generate();
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    try {
        await jobManager.createSanityProcessingJobs(ctx);
    } catch (err) {
        ctx.logger.error(`Error while creating sanity processing jobs`, { err });
    }
    setTimeout(createSanityProcessingJobs, config.SanityJobsCreationIntervalSec * 1000);
}

const asapFetcher = new ASAPPubKeyFetcher(config.AsapPubKeyBaseUrl, config.AsapPubKeyTTL);

pollForMetrics(metricsLoop);

async function pollForMetrics(metricsLoop: MetricsLoop) {
    await metricsLoop.updateMetrics();
    setTimeout(pollForMetrics.bind(null, metricsLoop), config.MetricsLoopIntervalMs);
}

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
});

const validator = new Validator({ instanceTracker, instanceGroupManager, metricsLoop, shutdownManager });
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
// This is placed last in the middleware chain and is our default error handler.
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

    if (err.name === 'UnauthorizedError') {
        l.info(`unauthorized token ${err}`, { u: req.url });
        res.status(401).send('invalid token...');
    } else {
        l.error(`internal error ${err}`, { u: req.url, stack: err.stack });
        res.status(500).send('internal server error');
    }
});

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
    body('scalingOptions.minDesired').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.maxDesired').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions.desiredCount').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scalingOptions').custom((value) => {
        if (!validator.groupHasValidDesiredValues(value.minDesired, value.maxDesired, value.desiredCount)) {
            throw new Error('Desired count must be between min and max; min cannot be grater than max');
        }
        return true;
    }),
    body('type').custom((value) => {
        if (!validator.supportedInstanceType(value)) {
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
    body('minDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('maxDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('desiredCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body().custom(async (value, { req }) => {
        if (!(await validator.groupHasValidDesiredInput(req.params.name, value))) {
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
    body('scaleUpQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scaleDownQuantity').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scaleUpThreshold').optional().isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('scaleDownThreshold').optional().isFloat({ min: 0 }).withMessage('Value must be positive'),
    body('scalePeriod').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scaleUpPeriodsCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('scaleDownPeriodsCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
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

app.put('/groups/:name/scaling-activities', async (req, res, next) => {
    try {
        await h.updateScalingActivities(req, res);
    } catch (err) {
        next(err);
    }
});

app.put('/groups/:name/instance-configuration', body('instanceConfigurationId').isString(), async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        await h.updateInstanceConfiguration(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name/report', async (req, res, next) => {
    try {
        await h.getGroupReport(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name/instance-audit', async (req, res, next) => {
    try {
        await h.getInstanceAudit(req, res);
    } catch (err) {
        next(err);
    }
});

app.get('/groups/:name/group-audit', async (req, res, next) => {
    try {
        await h.getGroupAudit(req, res);
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

app.get('/groups/:name', async (req, res, next) => {
    try {
        await h.getInstanceGroup(req, res);
    } catch (err) {
        next(err);
    }
});

app.delete(
    '/groups/:name',
    param('name').custom(async (value) => {
        if (await validator.groupHasActiveInstances(initCtx, value)) {
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
    body('count').isInt({ min: 0 }).withMessage('Value must be positive'),
    body('maxDesired').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
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
    body('options.scalePeriod').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.scaleUpPeriodsCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('options.scaleDownPeriodsCount').optional().isInt({ min: 0 }).withMessage('Value must be positive'),
    body('instanceType').custom(async (value) => {
        if (!(await validator.supportedInstanceType(value))) {
            throw new Error('Instance type not supported. Use jvb, jigasi, nomad, jibri or sip-jibri instead');
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

app.post('/groups/:name/actions/reconfigure-instances', async (req, res, next) => {
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

mapp.listen(config.MetricsServerPort, () => {
    logger.info(`...listening on :${config.MetricsServerPort}`);
});

app.listen(config.HTTPServerPort, () => {
    logger.info(`...listening on :${config.HTTPServerPort}`);
});
