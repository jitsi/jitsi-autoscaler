// Polyfill SlowBuffer for Node >= 25 where it was removed.
// Required by buffer-equal-constant-time (transitive dep of jsonwebtoken).
const buffer = require('buffer');
if (!buffer.SlowBuffer) {
    buffer.SlowBuffer = Buffer;
}
