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
    REDIS_DB: envalid.num({ default: 0 }),
    REDIS_SCAN_COUNT: envalid.num({ default: 100 }),
    PROTECTED_API: envalid.bool({ default: true }),
    ASAP_PUB_KEY_TTL: envalid.num({ default: 3600 }),
    ASAP_PUB_KEY_BASE_URL: envalid.str(),
    ASAP_JWT_AUD: envalid.str(),
    ASAP_JWT_ACCEPTED_HOOK_ISS: envalid.str(),
    INITIAL_WAIT_FOR_POOLING_MS: envalid.num({ default: 120000 }),
    DRY_RUN: envalid.bool({ default: false }),
    GROUP_CONFIG_FILE: envalid.str(),
    DEFAULT_INSTANCE_CONFIGURATION_ID: envalid.str(),
    DEFAULT_COMPARTMENT_ID: envalid.str(),
    METRIC_TTL_SEC: envalid.num({ default: 3600 }), // seconds
    SERVICE_LEVEL_METRICS_TTL_SEC: envalid.num({ default: 600 }),
    IDLE_TTL_SEC: envalid.num({ default: 300 }), // seconds, default to 5 minutes
    PROVISIONING_TTL_SEC: envalid.num({ default: 900 }), // seconds
    SHUTDOWN_TTL_SEC: envalid.num({ default: 86400 }), // default 1 day
    RECONFIGURE_TTL_SEC: envalid.num({ default: 86400 }), // default 1 day
    SHUTDOWN_STATUS_TTL_SEC: envalid.num({ default: 600 }), // default 10 minutes
    AUDIT_TTL_SEC: envalid.num({ default: 172800 }), // default 2 day
    MAX_THROTTLE_THRESHOLD: envalid.num({ default: 40 }), // default max of 40 untracked per group to throttle scale up
    GROUP_RELATED_DATA_TTL_SEC: envalid.num({ default: 172800 }), // default 2 day; keep group related data max 2 days after the group is deleted or no action is performed on it
    GROUP_LOCK_TTL_MS: envalid.num({ default: 180000 }), // time in ms
    GROUP_JOBS_CREATION_INTERVAL_SEC: envalid.num({ default: 30 }), // with what interval this instance should try producing jobs for group processing
    SANITY_JOBS_CREATION_INTERVAL_SEC: envalid.num({ default: 240 }), // with what interval this instance should try producing jobs for sanity check
    GROUP_JOBS_CREATION_GRACE_PERIOD_SEC: envalid.num({ default: 30 }), // jobs for group processing should be created once every JOB_CREATION_GRACE_PERIOD_SEC
    SANITY_JOBS_CREATION_GRACE_PERIOD_SEC: envalid.num({ default: 240 }), // jobs for sanity check should be created once every SANITY_JOBS_CREATION_GRACE_PERIOD_SEC
    JOBS_CREATION_LOCK_TTL_MS: envalid.num({ default: 30000 }), // job creation lock ensures only one instance at a time can produce jobs
    SANITY_LOOP_PROCESSING_TIMEOUT_MS: envalid.num({ default: 180000 }), // max time allowed for a sanity job to finish processing until it times out - in ms
    METRICS_LOOP_INTERVAL_MS: envalid.num({ default: 60000 }), // time in ms
    REPORT_EXT_CALL_MAX_TIME_IN_SECONDS: envalid.num({ default: 60 }),
    REPORT_EXT_CALL_MAX_DELAY_IN_SECONDS: envalid.num({ default: 30 }),
    REPORT_EXT_CALL_RETRYABLE_STATUS_CODES: envalid.str({ default: '429 409' }), // Retry on Too Many Requests, Conflict
    CLOUD_PROVIDER: envalid.str({ default: 'oracle' }),
    CLOUD_PROVIDERS: envalid.str({ default: '' }),

    OCI_CONFIGURATION_FILE_PATH: envalid.str({ default: '' }),
    OCI_CONFIGURATION_PROFILE: envalid.str({ default: '' }),

    DIGITALOCEAN_CONFIGURATION_FILE_PATH: envalid.str({ default: '' }),
    DIGITALOCEAN_API_TOKEN: envalid.str({ default: '' }),

    CUSTOM_CONFIGURATION_LAUNCH_SCRIPT_TIMEOUT_MS: envalid.num({ default: 60000 }),
    CUSTOM_CONFIGURATION_LAUNCH_SCRIPT_FILE_PATH: envalid.str({ default: './scripts/custom-launch.sh' }),
});

const cloudProviders = env.CLOUD_PROVIDERS ? (env.CLOUD_PROVIDERS as string).split(',') : [env.CLOUD_PROVIDER];

if (cloudProviders.includes('oracle')) {
    // ensure that oracle cloud envs are present
    envalid.cleanEnv(process.env, {
        OCI_CONFIGURATION_FILE_PATH: envalid.str(),
        OCI_CONFIGURATION_PROFILE: envalid.str(),
    });
}

if (cloudProviders.includes('digitalocean')) {
    // ensure that digitalocean cloud envs are present
    envalid.cleanEnv(process.env, {
        DIGITALOCEAN_CONFIGURATION_FILE_PATH: envalid.str(),
        DIGITALOCEAN_API_TOKEN: envalid.str(),
    });
}

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
    RedisDb: env.REDIS_DB,
    RedisScanCount: env.REDIS_SCAN_COUNT,
    ProtectedApi: env.PROTECTED_API,
    AsapPubKeyTTL: env.ASAP_PUB_KEY_TTL,
    AsapPubKeyBaseUrl: env.ASAP_PUB_KEY_BASE_URL,
    AsapJwtAcceptedAud: env.ASAP_JWT_AUD,
    AsapJwtAcceptedHookIss: env.ASAP_JWT_ACCEPTED_HOOK_ISS.split(','),
    GroupList: groupList,
    InitialWaitForPooling: env.INITIAL_WAIT_FOR_POOLING_MS,
    DryRun: env.DRY_RUN,
    // tracker TTLs
    MetricTTL: env.METRIC_TTL_SEC,
    ServiceLevelMetricsTTL: env.SERVICE_LEVEL_METRICS_TTL_SEC,
    ProvisioningTTL: env.PROVISIONING_TTL_SEC,
    IdleTTL: env.IDLE_TTL_SEC,
    ShutdownStatusTTL: env.SHUTDOWN_STATUS_TTL_SEC,
    ShutDownTTL: env.SHUTDOWN_TTL_SEC,
    ReconfigureTTL: env.RECONFIGURE_TTL_SEC,
    AuditTTL: env.AUDIT_TTL_SEC,
    GroupRelatedDataTTL: env.GROUP_RELATED_DATA_TTL_SEC,
    // group processing lock
    GroupLockTTLMs: env.GROUP_LOCK_TTL_MS,
    // group untracked threshold
    MaxThrottleThreshold: env.MAX_THROTTLE_THRESHOLD,
    // queue jobs producers
    GroupJobsCreationIntervalSec: env.GROUP_JOBS_CREATION_INTERVAL_SEC,
    SanityJobsCreationIntervalSec: env.SANITY_JOBS_CREATION_INTERVAL_SEC,
    GroupJobsCreationGracePeriodSec: env.GROUP_JOBS_CREATION_GRACE_PERIOD_SEC,
    SanityJobsCreationGracePeriodSec: env.SANITY_JOBS_CREATION_GRACE_PERIOD_SEC,
    JobsCreationLockTTLMs: env.JOBS_CREATION_LOCK_TTL_MS,
    // queue jobs consumers
    GroupProcessingTimeoutMs: env.GROUP_LOCK_TTL_MS, // timeout for processing a group is equal to the timeout for locking a group for processing
    SanityProcessingTimoutMs: env.SANITY_LOOP_PROCESSING_TIMEOUT_MS,
    // metrics loop
    MetricsLoopIntervalMs: env.METRICS_LOOP_INTERVAL_MS,
    // other
    CloudProviders: cloudProviders,
    OciConfigurationFilePath: env.OCI_CONFIGURATION_FILE_PATH,
    OciConfigurationProfile: env.OCI_CONFIGURATION_PROFILE,
    DigitalOceanConfigurationFilePath: env.DIGITALOCEAN_CONFIGURATION_FILE_PATH,
    DigitalOceanAPIToken: env.DIGITALOCEAN_API_TOKEN,

    CustomConfigurationLaunchScriptTimeoutMs: env.CUSTOM_CONFIGURATION_LAUNCH_SCRIPT_TIMEOUT_MS,
    CustomConfigurationLaunchScriptPath: env.CUSTOM_CONFIGURATION_LAUNCH_SCRIPT_FILE_PATH,

    ReportExtCallMaxTimeInSeconds: env.REPORT_EXT_CALL_MAX_TIME_IN_SECONDS,
    ReportExtCallMaxDelayInSeconds: env.REPORT_EXT_CALL_MAX_DELAY_IN_SECONDS,
    ReportExtCallRetryableStatusCodes: env.REPORT_EXT_CALL_RETRYABLE_STATUS_CODES.split(' ').map(
        (statusCodeAsString) => {
            return Number(statusCodeAsString);
        },
    ),
};
