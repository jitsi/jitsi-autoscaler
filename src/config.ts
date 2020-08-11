import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { InstanceGroup } from './instance_group';

const result = dotenv.config();

if (result.error) {
    throw result.error;
}

const groupsJsonRaw: string = fs.readFileSync(process.env.GROUP_CONFIG_FILE, { encoding: 'utf-8' });
const groupList: Array<InstanceGroup> = JSON.parse(groupsJsonRaw)['groupEntries'];

groupList.forEach((group) => {
    if (!group.instanceConfigurationId) {
        group.instanceConfigurationId = process.env.DEFAULT_INSTANCE_CONFIGURATION_ID;
    }
    if (!group.compartmentId) {
        group.compartmentId = process.env.DEFAULT_COMPARTMENT_ID;
    }
});

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
    DryRun: Boolean(process.env.DRY_RUN || true),
    GroupList: groupList,
};
