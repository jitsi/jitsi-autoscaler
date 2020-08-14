import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { InstanceGroup } from './instance_group';
import envalid from 'envalid';

const result = dotenv.config();

if (result.error) {
    throw result.error;
}

const env = envalid.cleanEnv(process.env, {
    PORT: envalid.num({ default: 3000 }),
    LOG_LEVEL: envalid.str({ default: 'info' }),
    REDIS_HOST: envalid.str({ default: '127.0.0.1' }),
    REDIS_PORT: envalid.num({ default: 6379 }),
    REDIS_PASSWORD: envalid.str({ default: '' }),
    REDIS_TLS: envalid.bool({ default: false }),
    PROTECTED_API: envalid.bool({ default: true }),
    ASAP_PUB_KEY_TTL: envalid.num({ default: 3600 }),
    ASAP_PUB_KEY_BASE_URL: envalid.str(),
    ASAP_JWT_AUD: envalid.str(),
    ASAP_JWT_ACCEPTED_HOOK_ISS: envalid.str(),
    AUTOSCALER_INTERVAL: envalid.num({ default: 10 }),
    JIBRI_MIN_DESIRED: envalid.num({ default: 1 }),
    JIBRI_MAX_DESIRED: envalid.num({ default: 1 }),
    DRY_RUN: envalid.bool({ default: false }),
    GROUP_CONFIG_FILE: envalid.str(),
    DEFAULT_INSTANCE_CONFIGURATION_ID: envalid.str(),
    DEFAULT_COMPARTMENT_ID: envalid.str(),
    METRIC_TTL: envalid.num({ default: 900 }), // seconds
    IDLE_TTL: envalid.num({ default: 90 }), // seconds
    GRACE_PERIOD_TTL: envalid.num({ default: 300 }), // seconds
});

const groupsJsonRaw: string = fs.readFileSync(env.GROUP_CONFIG_FILE, { encoding: 'utf-8' });
const groupList: Array<InstanceGroup> = JSON.parse(groupsJsonRaw)['groupEntries'];

groupList.forEach((group) => {
    if (!group.instanceConfigurationId) {
        group.instanceConfigurationId = env.DEFAULT_INSTANCE_CONFIGURATION_ID;
    }
    if (!group.compartmentId) {
        group.compartmentId = env.DEFAULT_COMPARTMENT_ID;
    }
});

export default {
    HTTPServerPort: env.PORT,
    LogLevel: env.LOG_LEVEL,
    RedisHost: env.REDIS_HOST,
    RedisPort: env.REDIS_PORT,
    RedisPassword: env.REDIS_PASSWORD,
    RedisTLS: env.REDIS_TLS,
    ProtectedApi: env.PROTECTED_API,
    AsapPubKeyTTL: env.ASAP_PUB_KEY_TTL,
    AsapPubKeyBaseUrl: env.ASAP_PUB_KEY_BASE_URL,
    AsapJwtAcceptedAud: env.ASAP_JWT_AUD,
    AsapJwtAcceptedHookIss: env.ASAP_JWT_ACCEPTED_HOOK_ISS,
    // interval for autoscaling calculation, in seconds
    AutoscalerInterval: env.AUTOSCALER_INTERVAL,
    GroupList: groupList,
    DryRun: env.DRY_RUN,
    MetricTTL: env.METRIC_TTL,
    IdleTTL: env.IDLE_TTL,
    GracePeriodTTL: env.GRACE_PERIOD_TTL,
};
