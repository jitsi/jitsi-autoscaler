// Test bootstrap: register ts-node so the TypeScript polyfill module can be required,
// then load the same SlowBuffer shim the app and MCP server use.
require('ts-node/register');
require('../polyfills');
