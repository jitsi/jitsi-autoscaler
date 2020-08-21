import bodyParser from 'body-parser';
import config from './config';
import express from 'express';
import * as context from './context';
import Handlers from './handlers';
import Redis from 'ioredis';
import logger from './logger';
import shortid from 'shortid';
import { ASAPPubKeyFetcher, unauthErrMiddleware } from './asap';
import jwt from 'express-jwt';
import { JibriTracker } from './jibri_tracker';
import CloudManager from './cloud_manager';
import { InstanceStatus } from './instance_status';
import InstanceGroupManager from './instance_group';
import AutoscaleProcessor from './autoscaler';
import InstanceLauncher from './instance_launcher';
import LockManager from './lock_manager';
import * as stats from './stats';

//import { RequestTracker, RecorderRequestMeta } from './request_tracker';
//import * as meet from './meet_processor';

//const jwtSigningKey = fs.readFileSync(meet.TokenSigningKeyFile);

const app = express();
app.use(bodyParser.json());

// TODO: unittesting
// TODO: readme updates and docker compose allthethings

app.get('/health', (req: express.Request, res: express.Response) => {
    res.send('healthy!');
});

const redisOptions = <Redis.RedisOptions>{
    host: config.RedisHost,
    port: config.RedisPort,
};

if (config.RedisPassword) {
    redisOptions.password = config.RedisPassword;
}

if (config.RedisTLS) {
    redisOptions.tls = {};
}

const redisClient = new Redis(redisOptions);

const jibriTracker = new JibriTracker({
    redisClient,
    idleTTL: config.IdleTTL,
    metricTTL: config.MetricTTL,
    provisioningTTL: config.ProvisioningTTL,
});

const instanceStatus = new InstanceStatus({ redisClient, jibriTracker });

const cloudManager = new CloudManager({
    instanceStatus: instanceStatus,
    isDryRun: config.DryRun,
    ociConfigurationFilePath: config.OciConfigurationFilePath,
    ociConfigurationProfile: config.OciConfigurationProfile,
    jibriTracker: jibriTracker,
});

const lockManager: LockManager = new LockManager(logger, {
    redisClient: redisClient,
    autoscalerProcessingLockTTL: config.AutoscalerProcessingLockTTL,
    scalerProcessingLockTTL: config.AutoscalerProcessingLockTTL,
});

const instanceGroupManager = new InstanceGroupManager({
    redisClient: redisClient,
    initialGroupList: config.GroupList,
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
});

async function startPooling() {
    logger.info('Start pooling..');

    pollForAutoscaling(autoscaleProcessor);
    pollForLaunching(instanceLauncher);
}
setTimeout(startPooling, config.InitialWaitForPooling);

async function pollForAutoscaling(autoscaleProcessor: AutoscaleProcessor) {
    const start = Date.now();
    const pollId = shortid.generate();
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    await autoscaleProcessor.processAutoscaling(ctx);
    setTimeout(pollForAutoscaling.bind(null, autoscaleProcessor), config.AutoscalerInterval * 1000);
}

async function pollForLaunching(instanceLauncher: InstanceLauncher) {
    const start = Date.now();
    const pollId = shortid.generate();
    const pollLogger = logger.child({
        id: pollId,
    });
    const ctx = new context.Context(pollLogger, start, pollId);
    await instanceLauncher.launchInstances(ctx);
    setTimeout(pollForLaunching.bind(null, instanceLauncher), config.AutoscalerInterval * 1000);
}

const asapFetcher = new ASAPPubKeyFetcher(config.AsapPubKeyBaseUrl, config.AsapPubKeyTTL);

const h = new Handlers(jibriTracker, instanceStatus, instanceGroupManager, lockManager);

const loggedPaths = ['/hook/v1/status', '/sidecar*', '/groups*'];
app.use(loggedPaths, stats.middleware);
app.use(loggedPaths, context.injectContext);
app.use(loggedPaths, context.accessLogger);
app.use(loggedPaths, unauthErrMiddleware);
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

app.put('/groups/:name', async (req, res, next) => {
    try {
        await h.upsertInstanceGroup(req, res);
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

app.delete('/groups/:name', async (req, res, next) => {
    try {
        await h.deleteInstanceGroup(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/groups/actions/reset', async (req, res, next) => {
    try {
        await h.resetInstanceGroups(req, res);
    } catch (err) {
        next(err);
    }
});

app.listen(config.HTTPServerPort, () => {
    logger.info(`...listening on :${config.HTTPServerPort}`);
});
