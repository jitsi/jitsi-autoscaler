import * as dotenv from 'dotenv';

dotenv.config();

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
    CloudProvider: process.env.CLOUD_PROVIDER || 'oracle',
    InstanceConfigurationId: process.env.INSTANCE_CONFIGURATION_ID,
    CompartmentId: process.env.COMPARTMENT_ID,
    // interval for autoscaling calculation, in seconds
    AutoscalerInterval: Number(process.env.AUTOSCALER_INTERVAL || 10),
    JibriMinDesired: Number(process.env.JIBRI_MIN_DESIRED || 1),
    JibriMaxDesired: Number(process.env.JIBRI_MAX_DESIRED || 1),
    JibriScaleUpQuantity: Number(process.env.JIBRI_SCALE_UP_QUANTITY),
    JibriScaleDownQuantity: Number(process.env.JIBRI_SCALE_DOWN_QUANTITY),
    JibriGroupList: (process.env.JIBRI_GROUP_LIST || 'default').split(' '),
    // Scale out if less than 1 jibris is available for 2 periods of 60 seconds
    JibriScaleUpThreshold: Number(process.env.JIBRI_SCALE_UP_THRESHOLD || 1),
    // Scale in if more than 2 jibris are available for 10 periods of 60 seconds
    JibriScaleDownThreshold: Number(process.env.JIBRI_SCALE_DOWN_THRESHOLD || 2),
    // Jibris should send roughly every 60 seconds a new status report
    JibriScalePeriod: Number(process.env.JIBR_SCALE_PERIOD || 60),
    JibriScaleUpPeriodsCount: Number(process.env.JIBRI_SCALE_UP_PERIODS_COUNT || 2),
    JibriScaleDownPeriodsCount: Number(process.env.JIBRI_SCALE_DOWN_PERIODS_COUNT || 4),
};
