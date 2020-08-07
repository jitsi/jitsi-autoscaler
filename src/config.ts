import * as dotenv from 'dotenv';

const result = dotenv.config();

if (result.error) {
    throw result.error;
}

export default {
    HTTPServerPort: process.env.PORT || 3000,
    LogLevel: process.env.LOG_LEVEL || 'info',
    RedisHost: process.env.REDIS_HOST || '127.0.0.1',
    RedisPort: process.env.REDIS_PORT || 6379,
    RedisPassword: process.env.REDIS_PASSWORD,
    ProtectedApi: process.env.PROTECTED_API || true,
    AsapPubKeyTTL: Number(process.env.ASAP_PUB_KEY_TTL || 3600),
    AsapPubKeyBaseUrl: process.env.ASAP_PUB_KEY_BASE_URL,
    AsapJwtAcceptedAud: process.env.ASAP_JWT_AUD,
    AsapJwtAcceptedHookIss: process.env.ASAP_JWT_ACCEPTED_HOOK_ISS,
    AutoscalerInterval: Number(process.env.AUTOSCALER_INTERVAL || 10),
    DefaultInstanceConfigurationId: process.env.DEFAULT_INSTANCE_CONFIGURATION_ID,
    DefaultCompartmentId: process.env.DEFAULT_COMPARTMENT_ID,
    DryRun: Boolean(process.env.DRY_RUN || true),
};
