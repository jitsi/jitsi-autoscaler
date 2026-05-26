import { cleanEnv, str } from 'envalid';
import dotenv from 'dotenv';

dotenv.config();

const config = cleanEnv(process.env, {
    MCP_AUTOSCALER_BASE_URL: str({ desc: 'Base URL of the autoscaler REST API' }),
    MCP_AUTH_TOKEN: str({ desc: 'JWT token for autoscaler API authentication' }),
});

export default config;
