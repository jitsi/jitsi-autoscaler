import bodyParser from 'body-parser';
import fs from 'fs';
import config from './config';
import express from 'express';
import Handlers from './handlers';
import Redis from 'ioredis';
import logger from './logger';
import ASAPPubKeyFetcher from './asap';
import jwt from 'express-jwt';
import { JibriTracker } from './jibri_tracker';

export const AsapPubKeyTTL: number = Number(process.env.ASAP_PUB_KEY_TTL) || 3600;
export const RecorderTokenExpSeconds: number = Number(process.env.RECORDER_TOKEN_TTL_SECONDS) || 30;
export const AsapPubKeyBaseUrl: string = process.env.ASAP_PUB_KEY_BASE_URL;
export const AsapJwtIss: string = process.env.ASAP_JWT_ISS;
export const AsapJwtKid: string = process.env.ASAP_JWT_KID;
export const AsapJwtAcceptedAud: string = process.env.ASAP_JWT_AUD;
export const AsapJwtAcceptedIss: string = process.env.ASAP_JWT_ACCEPTED_ISS;
export const AsapJwtAcceptedHookIss: string = process.env.ASAP_JWT_ACCEPTED_HOOK_ISS;
export const TokenSigningKeyFile: string = process.env.TOKEN_SIGNING_KEY_FILE;

//import { RequestTracker, RecorderRequestMeta } from './request_tracker';
//import * as meet from './meet_processor';

//const jwtSigningKey = fs.readFileSync(meet.TokenSigningKeyFile);
const app = express();
app.use(bodyParser.json());

// TODO: Add custom error handler for express that handles jwt 401/403
// TODO: Add prometheus stating middleware for each http
// TODO: Add http logging middleware
// TODO: metrics overview

// TODO: JWT Creation for Lua Module API
// TODO: JWT Creation for requestor

// TODO: unittesting
// TODO: doc strings???
// TODO: readme updates and docker compose allthethings

app.get('/health', (req: express.Request, res: express.Response) => {
    res.send('healthy!');
});

const redisClient = new Redis({
    host: config.RedisHost,
    port: Number(config.RedisPort),
    password: config.RedisPassword,
});
const jibriTracker = new JibriTracker(logger, redisClient);
const h = new Handlers(jibriTracker);
const asapFetcher = new ASAPPubKeyFetcher(logger, AsapPubKeyBaseUrl, AsapPubKeyTTL);

app.use(
    jwt({
        secret: asapFetcher.pubKeyCallback,
        audience: AsapJwtAcceptedAud,
        issuer: AsapJwtAcceptedHookIss,
        algorithms: ['RS256'],
    }).unless((req) => {
        if (req.path == '/health') return true;
        return config.ProtectedApi === 'false';
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

// const meetProcessor = new meet.MeetProcessor({
//     jibriTracker: jibriTracker,
//     signingKey: jwtSigningKey,
// });

// async function pollForRecorderReqs() {
//     await requestTracker.processNextRequest(meetProcessor.requestProcessor);
//     setTimeout(pollForRecorderReqs, 1000);
// }
// pollForRecorderReqs();

// async function pollForRequestUpdates() {
//     await requestTracker.processUpdates(meetProcessor.updateProcessor);
//     setTimeout(pollForRequestUpdates, 3000);
// }
// pollForRequestUpdates();

app.listen(config.HTTPServerPort, () => {
    logger.info(`...listening on :${config.HTTPServerPort}`);
});
