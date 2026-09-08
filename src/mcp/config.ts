import { cleanEnv, num, str } from 'envalid';
import dotenv from 'dotenv';

dotenv.config();

const config = cleanEnv(process.env, {
    MCP_AUTOSCALER_BASE_URL: str({ desc: 'Base URL of the autoscaler REST API' }),
    MCP_AUTH_TOKEN: str({ desc: 'JWT token for autoscaler API authentication' }),
    MCP_REQUEST_TIMEOUT_MS: num({ default: 30000, desc: 'Per-request timeout for autoscaler API calls, in ms' }),
});

export default config;
