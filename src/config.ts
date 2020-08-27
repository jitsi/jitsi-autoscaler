import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { InstanceGroup } from './instance_group';
import envalid from 'envalid';

const result = dotenv.config();

if (result.error) {
    const err = <NodeJS.ErrnoException>result.error;
    switch (err.code) {
        case 'ENOENT':
            // skip if only error is missing file, this isn't fatal
            console.debug('Missing .env file, not loading environment file disk');
            break;
        default:
            throw result.error;
            break;
    }
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
    GROUP_JOBS_CREATION_INTERVAL_SEC: envalid.num({ default: 30 }), // with what interval this instance should try producing jobs for group processing
    GROUP_JOBS_CREATION_GRACE_PERIOD_SEC: envalid.num({ default: 30 }), // jobs for group processing should be created once every JOB_CREATION_GRACE_PERIOD_SEC
    GROUP_JOBS_CREATION_LOCK_TTL_MS: envalid.num({ default: 30000 }), // job creation lock ensures only one instance at a time can produce jobs
    INITIAL_WAIT_FOR_POOLING_MS: envalid.num({ default: 120000 }),
    DRY_RUN: envalid.bool({ default: false }),
    GROUP_CONFIG_FILE: envalid.str(),
    DEFAULT_INSTANCE_CONFIGURATION_ID: envalid.str(),
    DEFAULT_COMPARTMENT_ID: envalid.str(),
    METRIC_TTL_SEC: envalid.num({ default: 900 }), // seconds
    IDLE_TTL_SEC: envalid.num({ default: 150 }), // seconds, default to 2.5 minutes
    PROVISIONING_TTL_SEC: envalid.num({ default: 600 }), // seconds
    SHUTDOWN_TTL_SEC: envalid.num({ default: 86400 }), // default 1 day
    AUTOSCALER_PROCESSING_LOCK_TTL_MS: envalid.num({ default: 180000 }), // time in ms
    OCI_CONFIGURATION_FILE_PATH: envalid.str(),
    OCI_CONFIGURATION_PROFILE: envalid.str({ default: 'DEFAULT' }),
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
    GroupJobsCreationIntervalSec: env.GROUP_JOBS_CREATION_INTERVAL_SEC,
    GroupJobsCreationGracePeriodSec: env.GROUP_JOBS_CREATION_GRACE_PERIOD_SEC,
    GroupJobsCreationLockTTLMs: env.GROUP_JOBS_CREATION_LOCK_TTL_MS,
    InitialWaitForPooling: env.INITIAL_WAIT_FOR_POOLING_MS,
    GroupList: groupList,
    DryRun: env.DRY_RUN,
    MetricTTL: env.METRIC_TTL_SEC,
    ProvisioningTTL: env.PROVISIONING_TTL_SEC,
    IdleTTL: env.IDLE_TTL_SEC,
    ShutDownTTL: env.SHUTDOWN_TTL_SEC,
    AutoscalerProcessingLockTTL: env.AUTOSCALER_PROCESSING_LOCK_TTL_MS,
    OciConfigurationFilePath: env.OCI_CONFIGURATION_FILE_PATH,
    OciConfigurationProfile: env.OCI_CONFIGURATION_PROFILE,
};
