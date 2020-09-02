import bodyParser from 'body-parser';
import config from './config';
import express from 'express';
import * as context from './context';
import Handlers from './handlers';
import Validator from './validator';
import Redis from 'ioredis';
import logger from './logger';
import shortid from 'shortid';
import { ASAPPubKeyFetcher } from './asap';
import jwt from 'express-jwt';
import { JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import { InstanceStatus } from './instance_status';
import InstanceGroupManager from './instance_group';
import AutoscaleProcessor from './autoscaler';
import InstanceLauncher from './instance_launcher';
import LockManager from './lock_manager';
import * as stats from './stats';
import ShutdownManager from './shutdown_manager';
import JobManager from './job_manager';
import GroupReportGenerator from './group_report';
import { ClientOpts } from 'redis';
import { body, param, validationResult } from 'express-validator';

//import { RequestTracker, RecorderRequestMeta } from './request_tracker';
//import * as meet from './meet_processor';

//const jwtSigningKey = fs.readFileSync(meet.TokenSigningKeyFile);

const app = express();
app.use(bodyParser.json());
app.use(express.json());

// TODO: unittesting
// TODO: readme updates and docker compose allthethings

app.get('/health', (req: express.Request, res: express.Response) => {
    res.send('healthy!');
});

const redisOptions = <Redis.RedisOptions>{
    host: config.RedisHost,
    port: config.RedisPort,
};
const redisQueueOptions = <ClientOpts>{
    host: config.RedisHost,
    port: config.RedisPort,
};

if (config.RedisPassword) {
    redisOptions.password = config.RedisPassword;
    redisQueueOptions.password = config.RedisPassword;
}

if (config.RedisTLS) {
    redisOptions.tls = {};
    redisQueueOptions.tls = {};
}

if (config.RedisDb) {
    redisOptions.db = config.RedisDb;
    redisQueueOptions.db = config.RedisDb;
}

const redisClient = new Redis(redisOptions);

const shutdownManager = new ShutdownManager({
    redisClient,
    shutdownTTL: config.ShutDownTTL,
});

const jibriTracker = new JibriTracker({
    redisClient,
    shutdownManager: shutdownManager,
    idleTTL: config.IdleTTL,
    metricTTL: config.MetricTTL,
    provisioningTTL: config.ProvisioningTTL,
});

const instanceStatus = new InstanceStatus({ redisClient, jibriTracker });

const cloudManager = new CloudManager({
    shutdownManager: shutdownManager,
    isDryRun: config.DryRun,
    ociConfigurationFilePath: config.OciConfigurationFilePath,
    ociConfigurationProfile: config.OciConfigurationProfile,
    jibriTracker: jibriTracker,
    instanceStatus: instanceStatus,
});

const lockManager: LockManager = new LockManager(logger, {
    redisClient: redisClient,
    jobCreationLockTTL: config.GroupJobsCreationLockTTLMs,
    autoscalerProcessingLockTTL: config.AutoscalerProcessingLockTTL,
});

const instanceGroupManager = new InstanceGroupManager({
    redisClient: redisClient,
    initialGroupList: config.GroupList,
    groupJobsCreationGracePeriod: config.GroupJobsCreationGracePeriodSec,
});

logger.info('Initializing instance group manager...');
const start = Date.now();
const initId = shortid.generate();
const initLogger = logger.child({ id: initId });
const initCtx = new context.Context(initLogger, start, initId);
instanceGroupManager.init(initCtx).catch((err) => {
    logger.info('Failed initializing list of groups', { err });
});

const autoscaleProcessor = new AutoscaleProcessor({
    jibriTracker: jibriTracker,
    cloudManager: cloudManager,
    instanceGroupManager: instanceGroupManager,
    lockManager: lockManager,
    redisClient,
});

const instanceLauncher = new InstanceLauncher({
    jibriTracker: jibriTracker,
    cloudManager: cloudManager,
    instanceGroupManager: instanceGroupManager,
    lockManager: lockManager,
    redisClient,
    shutdownManager,
});

const groupReportGenerator = new GroupReportGenerator({
    jibriTracker: jibriTracker,
    instanceGroupManager: instanceGroupManager,
    cloudManager: cloudManager,
    shutdownManager: shutdownManager,
    reportExtCallRetryStrategy: {
        maxTimeInSeconds: config.ReportExtCallMaxTimeInSeconds,
        maxDelayInSeconds: config.ReportExtCallMaxDelayInSeconds,
        retryableStatusCodes: config.ReportExtCallRetryableStatusCodes,
    },
});

// Each Queue in JobManager has its own Redis connection (other than the one in RedisClient)
// Bee-Queue also uses different a Redis library, so we map redisOptions to the object expected by Bee-Queue
const jobManager = new JobManager({
    queueRedisOptions: redisQueueOptions,
    lockManager: lockManager,
    instanceGroupManager: instanceGroupManager,
    instanceLauncher: instanceLauncher,
    autoscaler: autoscaleProcessor,
    autoscalerProcessingTimeoutMilli: config.AutoscalerProcessingLockTTL,
    launcherProcessingTimeoutMilli: config.AutoscalerProcessingLockTTL,
});

async function startProcessingGroups() {
    logger.info('Start pooling..');

    await createGroupProcessingJobs();
}
logger.info(`Waiting ${config.InitialWaitForPooling}ms before starting to loop for group processing`);
setTimeout(startProcessingGroups, config.InitialWaitForPooling);

async function createGroupProcessingJobs() {
    const start = Date.now();
    const pollId = shortid.generate();
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    await jobManager.createGroupProcessingJobs(ctx);
    setTimeout(createGroupProcessingJobs, config.GroupJobsCreationIntervalSec * 1000);
}

const asapFetcher = new ASAPPubKeyFetcher(config.AsapPubKeyBaseUrl, config.AsapPubKeyTTL);

const h = new Handlers({
    jibriTracker: jibriTracker,
    instanceStatus: instanceStatus,
    instanceGroupManager: instanceGroupManager,
    shutdownManager: shutdownManager,
    groupReportGenerator: groupReportGenerator,
    lockManager: lockManager,
});

const validator = new Validator(jibriTracker);
const loggedPaths = ['/hook/v1/status', '/sidecar*', '/groups*'];
app.use(loggedPaths, stats.middleware);
app.use(loggedPaths, context.injectContext);
app.use(loggedPaths, context.accessLogger);
stats.registerHandler(app, '/metrics');
app.use(
    jwt({
        secret: asapFetcher.pubKeyCallback,
        audience: config.AsapJwtAcceptedAud,
        issuer: config.AsapJwtAcceptedHookIss,
        algorithms: ['RS256'],
    }).unless((req) => {
        if (req.path == '/health') return true;
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
        l.info(`unauthorized token ${err}`);
        res.status(401).send('invalid token...');
    } else {
        l.error(`internal error ${err}`);
        res.status(500).send('internal server error');
    }
});

if (config.ProtectedApi) {
    logger.debug('starting in protected api mode');
} else {
    logger.warn('starting in unprotected api mode');
}

app.post('/hook/v1/status', async (req, res, next) => {
    try {
        await h.jibriStateWebhook(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/sidecar/poll', async (req, res, next) => {
    try {
        await h.sidecarPoll(req, res);
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
    '/groups/:name/desired-count',
    body('desiredCount').isInt({ min: 0 }).withMessage('Value must be positive'),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            await h.upsertDesiredCount(req, res);
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

app.get('/groups/:name/report', async (req, res, next) => {
    try {
        await h.getGroupReport(req, res);
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

app.listen(config.HTTPServerPort, () => {
    logger.info(`...listening on :${config.HTTPServerPort}`);
});
