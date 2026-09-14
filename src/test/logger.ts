/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import AutoscalerLogger from '../logger';
import assert from 'node:assert';
import test, { describe } from 'node:test';

const logger = new AutoscalerLogger({ logLevel: 'debug' }).createLogger('debug');

// The formats are run in order by winston.format.combine, so transforming an info object by hand
// gives us the exact JSON line the Console transport would write, without capturing stdout.
function render(info) {
    const transformed = logger.format.transform({ level: 'error', ...info }, logger.format.options);
    return JSON.parse(transformed[Symbol.for('message')]);
}

describe('error serialization', () => {
    // winston's json format drops a bare Error to {}, which blanked every `logger.error(..., { err })`
    // call in the app.
    test('an Error in metadata keeps its message and stack', () => {
        const line = render({
            message: '[Process] Error disconnecting Redis',
            err: new Error('Connection is closed.'),
        });

        assert.strictEqual(line.err.message, 'Connection is closed.');
        assert.strictEqual(line.err.name, 'Error');
        assert.match(line.err.stack, /Connection is closed\./);
    });

    test('own enumerable properties survive alongside message and stack', () => {
        const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', statusCode: 503 });
        const line = render({ message: 'oci call failed', err });

        assert.strictEqual(line.err.code, 'ENOTFOUND');
        assert.strictEqual(line.err.statusCode, 503);
        assert.strictEqual(line.err.message, 'getaddrinfo ENOTFOUND');
    });

    test('a subclass reports its own name', () => {
        class ResourceLockedError extends Error {
            constructor(message) {
                super(message);
                this.name = 'ResourceLockedError';
            }
        }
        const line = render({ message: 'lock failed', err: new ResourceLockedError('already held') });

        assert.strictEqual(line.err.name, 'ResourceLockedError');
        assert.strictEqual(line.err.message, 'already held');
    });

    test('non-Error metadata is passed through untouched', () => {
        const line = render({ message: 'group scanned', group: 'stage-8x8-us-phoenix-1-JibriCustomGroup', count: 3 });

        assert.strictEqual(line.group, 'stage-8x8-us-phoenix-1-JibriCustomGroup');
        assert.strictEqual(line.count, 3);
        assert.strictEqual(line.message, 'group scanned');
    });
});
