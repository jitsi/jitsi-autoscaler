import * as dotenv from 'dotenv';

dotenv.config();

export default {
    HTTPServerPort: process.env.PORT || 3000,
    LogLevel: process.env.LOG_LEVEL || 'info',
    RedisHost: process.env.REDIS_HOST || '127.0.0.1',
    RedisPort: process.env.REDIS_PORT || 6379,
    RedisPassword: process.env.REDIS_PASSWORD,
    ProtectedApi: process.env.PROTECTED_API || true,
};
