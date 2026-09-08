// Polyfill SlowBuffer for Node >= 25 where it was removed.
// Required by buffer-equal-constant-time (transitive dep of jsonwebtoken).
// Imported for its side effect by src/app.ts and src/mcp/server.ts.
import buffer from 'buffer';

const bufferModule = buffer as unknown as { SlowBuffer?: unknown };
if (!bufferModule.SlowBuffer) {
    bufferModule.SlowBuffer = Buffer;
}
