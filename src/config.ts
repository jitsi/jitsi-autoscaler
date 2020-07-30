import * as dotenv from 'dotenv';

dotenv.config();

export default {
    HTTPServerPort: process.env.PORT || 3000,
    LogLevel: process.env.LOG_LEVEL || 'info',
    RedisHost: process.env.REDIS_HOST || '127.0.0.1',
    RedisPort: process.env.REDIS_PORT || 6379,
    RedisPassword: process.env.REDIS_PASSWORD,
    ProtectedApi: process.env.PROTECTED_API || true,
    AsapPubKeyTTL: process.env.ASAP_PUB_KEY_TTL || 3600,
    AsapPubKeyBaseUrl: process.env.ASAP_PUB_KEY_BASE_URL,
    AsapJwtAcceptedAud: process.env.ASAP_JWT_AUD,
    AsapJwtAcceptedHookIss: process.env.ASAP_JWT_ACCEPTED_HOOK_ISS,
    // interval for autoscaling calculation, in seconds
    AutoscalerInterval: Number(process.env.AUTOSCALER_INTERVAL || 10),
    JibriMinDesired: Number(process.env.JIBRI_MIN_DESIRED || 1),
    JibriMaxDesired: Number(process.env.JIBRI_MAX_DESIRED || 1),
    JibriGroupList: (process.env.JIBRI_GROUP_LIST || 'default').split(' '),
};
