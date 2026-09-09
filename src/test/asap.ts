/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import http from 'node:http';
import test, { afterEach, beforeEach, describe, mock } from 'node:test';
import sha256 from 'sha256';

import Module from 'node:module';

// asap.ts reads `req.context`, which is declared as a global Express augmentation in context.ts but
// never imported there, so context.ts must be compiled before asap.ts for the type checker to see it.
// context.ts in turn imports config.ts, whose envalid validation exits the process when the autoscaler
// env vars are absent (as in CI). Stub config in the require cache first (context only reads LogLevel),
// then load context and asap at runtime rather than via hoisted imports.
function stubModule(request, exports) {
    const filename = require.resolve(request);
    const stub = new Module(filename, module);
    stub.filename = filename;
    stub.loaded = true;
    stub.exports = exports;
    require.cache[filename] = stub;
}
stubModule('../config', { __esModule: true, default: { LogLevel: 'error' } });
require('../context');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ASAPPubKeyFetcher } = require('../asap');

// asap.ts is compiled with esModuleInterop, so every key fetch goes through `require('got').default`.
// That property is a plain writable slot on the got module object, so replacing it intercepts the
// outbound request without touching the module under test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gotModule = require('got');
const realGot = gotModule.default;

// Mirrors the constants in asap.ts. If these drift the assertions below will say so.
const KEY_FETCH_TIMEOUT_MS = 5000;
const FAILED_KID_TTL_SEC = 60;

describe('ASAPPubKeyFetcher', () => {
    const baseUrl = 'https://keys.example.com/server';
    let logger;
    let req;
    let fetchCalls;

    // Install a got replacement that records every call and delegates to `impl`.
    function stubGot(impl) {
        gotModule.default = (url, options) => {
            fetchCalls.push({ url, options });
            return impl(url, options);
        };
    }

    function tokenFor(kid) {
        return { header: { kid } };
    }

    // Shaped like got's HTTPError: name plus the response status the key server answered with.
    function httpError(statusCode) {
        const err = new Error(`Response code ${statusCode}`);
        err.name = 'HTTPError';
        err.response = { statusCode };
        return err;
    }

    // Behaves like got's request timeout error.
    function timeoutError() {
        const err = new Error('Timeout awaiting request');
        err.name = 'TimeoutError';
        return err;
    }

    beforeEach(() => {
        logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() };
        req = { context: { logger } };
        fetchCalls = [];
    });

    afterEach(() => {
        gotModule.default = realGot;
        mock.timers.reset();
    });

    describe('token validation', () => {
        test('rejects a token without a header as credentials_bad_format without fetching', async () => {
            stubGot(() => Promise.resolve({ body: 'PEM' }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            await assert.rejects(fetcher.secretCallback(req, undefined), (err) => {
                assert.strictEqual(err.name, 'UnauthorizedError');
                assert.strictEqual(err.code, 'credentials_bad_format');
                assert.strictEqual(err.status, 401);
                assert.match(err.message, /could not be decoded/);
                return true;
            });
            assert.strictEqual(fetchCalls.length, 0);
        });

        test('rejects a token whose header has no kid as credentials_bad_format without fetching', async () => {
            stubGot(() => Promise.resolve({ body: 'PEM' }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            await assert.rejects(fetcher.secretCallback(req, { header: {} }), (err) => {
                assert.strictEqual(err.code, 'credentials_bad_format');
                assert.match(err.message, /kid is required/);
                return true;
            });
            assert.strictEqual(fetchCalls.length, 0);
        });
    });

    describe('key URL construction', () => {
        test('requests <baseUrl>/<sha256(kid)>.pem with the key-server timeout and a single retry', async () => {
            stubGot(() => Promise.resolve({ body: 'PEM' }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);
            const kid = 'jitsi/some-key-id';

            await fetcher.secretCallback(req, tokenFor(kid));

            assert.strictEqual(fetchCalls.length, 1);
            assert.strictEqual(fetchCalls[0].url, `${baseUrl}/${sha256(kid)}.pem`);
            // The raw kid must never leak into the URL; only its hash is used as the file name.
            assert.ok(!fetchCalls[0].url.includes(kid));
            assert.deepStrictEqual(fetchCalls[0].options.timeout, { request: KEY_FETCH_TIMEOUT_MS });
            assert.deepStrictEqual(fetchCalls[0].options.retry, { limit: 1 });
        });

        test('fetches the PEM from a real HTTP key server at the hashed path', async () => {
            const seenPaths = [];
            const server = http.createServer((request, response) => {
                seenPaths.push(request.url);
                if (request.url.endsWith('/missing.pem')) {
                    response.statusCode = 404;
                    response.end('not found');
                    return;
                }
                response.setHeader('content-type', 'application/x-pem-file');
                response.end('-----BEGIN PUBLIC KEY-----\nREAL\n-----END PUBLIC KEY-----\n');
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const port = server.address().port;
                const fetcher = new ASAPPubKeyFetcher(`http://127.0.0.1:${port}/keys`, 3600);
                const kid = 'real-kid';

                const key = await fetcher.secretCallback(req, tokenFor(kid));

                assert.strictEqual(key, '-----BEGIN PUBLIC KEY-----\nREAL\n-----END PUBLIC KEY-----\n');
                assert.deepStrictEqual(seenPaths, [`/keys/${sha256(kid)}.pem`]);
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        });

        test('a 404 from a real key server surfaces as invalid_token and is negatively cached', async () => {
            let hits = 0;
            const server = http.createServer((_request, response) => {
                hits++;
                response.statusCode = 404;
                response.end('not found');
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const port = server.address().port;
                const fetcher = new ASAPPubKeyFetcher(`http://127.0.0.1:${port}/keys`, 3600);

                await assert.rejects(fetcher.secretCallback(req, tokenFor('unknown-kid')), (err) => {
                    assert.strictEqual(err.name, 'UnauthorizedError');
                    assert.strictEqual(err.code, 'invalid_token');
                    assert.match(err.message, /404/);
                    return true;
                });
                assert.strictEqual(logger.error.mock.callCount(), 1);
                assert.strictEqual(hits, 1);

                // The real got HTTPError is recognised as definitive: the second call never reaches the server.
                await assert.rejects(
                    fetcher.secretCallback(req, tokenFor('unknown-kid')),
                    /failed to fetch public key/,
                );
                assert.strictEqual(hits, 1);
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        });

        test('a 503 from a real key server is not negatively cached: the next call asks the server again', async () => {
            let hits = 0;
            const server = http.createServer((_request, response) => {
                hits++;
                if (hits <= 2) {
                    // got retries once (retry.limit 1), so the first secretCallback consumes two hits.
                    response.statusCode = 503;
                    response.end('unavailable');
                    return;
                }
                response.end('RECOVERED-PEM');
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const port = server.address().port;
                const fetcher = new ASAPPubKeyFetcher(`http://127.0.0.1:${port}/keys`, 3600);

                await assert.rejects(fetcher.secretCallback(req, tokenFor('kid-1')), (err) => {
                    assert.strictEqual(err.code, 'invalid_token');
                    assert.match(err.message, /503/);
                    return true;
                });
                const hitsAfterFailure = hits;
                assert.ok(hitsAfterFailure >= 1);

                assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'RECOVERED-PEM');
                assert.ok(hits > hitsAfterFailure);
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        });
    });

    describe('caching', () => {
        test('caches a fetched key so a second call for the same kid does not refetch', async () => {
            stubGot(() => Promise.resolve({ body: 'PEM-1' }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            const first = await fetcher.secretCallback(req, tokenFor('kid-1'));
            const second = await fetcher.secretCallback(req, tokenFor('kid-1'));

            assert.strictEqual(first, 'PEM-1');
            assert.strictEqual(second, 'PEM-1');
            assert.strictEqual(fetchCalls.length, 1);
            const cacheHits = logger.debug.mock.calls.filter((c) => c.arguments[0] === 'using pub key from cache');
            assert.strictEqual(cacheHits.length, 1);
        });

        test('different kids are fetched and cached independently', async () => {
            stubGot((url) => Promise.resolve({ body: `PEM for ${url}` }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            const a = await fetcher.secretCallback(req, tokenFor('kid-a'));
            const b = await fetcher.secretCallback(req, tokenFor('kid-b'));
            await fetcher.secretCallback(req, tokenFor('kid-a'));
            await fetcher.secretCallback(req, tokenFor('kid-b'));

            assert.strictEqual(fetchCalls.length, 2);
            assert.notStrictEqual(a, b);
            assert.strictEqual(a, `PEM for ${baseUrl}/${sha256('kid-a')}.pem`);
            assert.strictEqual(b, `PEM for ${baseUrl}/${sha256('kid-b')}.pem`);
        });

        test('a cached key expires after the configured ttl and is fetched again', async () => {
            mock.timers.enable({ apis: ['Date'], now: Date.now() });
            let counter = 0;
            stubGot(() => Promise.resolve({ body: `PEM-${++counter}` }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 30);

            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'PEM-1');
            mock.timers.tick(29_000);
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'PEM-1');
            assert.strictEqual(fetchCalls.length, 1);

            mock.timers.tick(2_000);
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'PEM-2');
            assert.strictEqual(fetchCalls.length, 2);
        });
    });

    describe('in-flight coalescing', () => {
        test('concurrent calls for the same kid share a single outbound fetch', async () => {
            let resolveFetch;
            stubGot(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            );
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            const pending = [
                fetcher.secretCallback(req, tokenFor('kid-1')),
                fetcher.secretCallback(req, tokenFor('kid-1')),
                fetcher.secretCallback(req, tokenFor('kid-1')),
            ];
            // Let every caller reach its fetch before the response arrives.
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(fetchCalls.length, 1);

            resolveFetch({ body: 'SHARED-PEM' });
            const results = await Promise.all(pending);

            assert.deepStrictEqual(results, ['SHARED-PEM', 'SHARED-PEM', 'SHARED-PEM']);
            assert.strictEqual(fetchCalls.length, 1);
        });

        test('concurrent calls for different kids each get their own fetch', async () => {
            stubGot((url) => Promise.resolve({ body: url }));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            const [a, b] = await Promise.all([
                fetcher.secretCallback(req, tokenFor('kid-a')),
                fetcher.secretCallback(req, tokenFor('kid-b')),
            ]);

            assert.strictEqual(fetchCalls.length, 2);
            assert.notStrictEqual(a, b);
        });

        test('a shared in-flight failure rejects every waiting caller and is recorded once', async () => {
            let rejectFetch;
            stubGot(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectFetch = reject;
                    }),
            );
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            const pending = [
                fetcher.secretCallback(req, tokenFor('kid-1')),
                fetcher.secretCallback(req, tokenFor('kid-1')),
            ];
            await new Promise((resolve) => setImmediate(resolve));
            rejectFetch(new Error('key server exploded'));

            const settled = await Promise.allSettled(pending);
            assert.deepStrictEqual(
                settled.map((s) => s.status),
                ['rejected', 'rejected'],
            );
            settled.forEach((s) => {
                assert.strictEqual(s.reason.code, 'invalid_token');
                assert.strictEqual(s.reason.message, 'key server exploded');
            });
            assert.strictEqual(fetchCalls.length, 1);
        });
    });

    describe('negative caching of failed kids', () => {
        test('a definitive 404 is remembered so the next call rejects immediately without refetching', async () => {
            stubGot(() => Promise.reject(httpError(404)));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);
            const kid = 'bad-kid';

            await assert.rejects(fetcher.secretCallback(req, tokenFor(kid)), (err) => {
                assert.strictEqual(err.name, 'UnauthorizedError');
                assert.strictEqual(err.code, 'invalid_token');
                assert.strictEqual(err.message, 'Response code 404');
                assert.strictEqual(err.inner.name, 'HTTPError');
                return true;
            });
            assert.strictEqual(fetchCalls.length, 1);
            assert.strictEqual(logger.error.mock.callCount(), 1);
            assert.strictEqual(logger.error.mock.calls[0].arguments[1].negativelyCached, true);

            await assert.rejects(fetcher.secretCallback(req, tokenFor(kid)), (err) => {
                assert.strictEqual(err.code, 'invalid_token');
                assert.match(err.message, new RegExp(`failed to fetch public key for kid ${kid}`));
                assert.match(err.message, /404/);
                return true;
            });
            // No second outbound request and no second error log: the rejection came from the negative cache.
            assert.strictEqual(fetchCalls.length, 1);
            assert.strictEqual(logger.error.mock.callCount(), 1);
            const shortCircuits = logger.debug.mock.calls.filter((c) =>
                String(c.arguments[0]).includes('recently failed for kid'),
            );
            assert.strictEqual(shortCircuits.length, 1);
        });

        test('the negative cache entry expires after the failed-kid ttl and the key is fetched again', async () => {
            mock.timers.enable({ apis: ['Date'], now: Date.now() });
            let shouldFail = true;
            stubGot(() => (shouldFail ? Promise.reject(httpError(404)) : Promise.resolve({ body: 'PEM-OK' })));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);
            const kid = 'flaky-kid';

            await assert.rejects(fetcher.secretCallback(req, tokenFor(kid)));
            shouldFail = false;

            // Still inside the negative-cache window: rejected from memory even though the server has recovered.
            mock.timers.tick((FAILED_KID_TTL_SEC - 1) * 1000);
            await assert.rejects(fetcher.secretCallback(req, tokenFor(kid)), /failed to fetch public key/);
            assert.strictEqual(fetchCalls.length, 1);

            // Past the window: the key server is asked again and the answer is cached.
            mock.timers.tick(2_000);
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor(kid)), 'PEM-OK');
            assert.strictEqual(fetchCalls.length, 2);
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor(kid)), 'PEM-OK');
            assert.strictEqual(fetchCalls.length, 2);
        });

        test('a failure for one kid does not block fetches for another kid', async () => {
            stubGot((url) =>
                url.includes(sha256('bad-kid')) ? Promise.reject(httpError(404)) : Promise.resolve({ body: 'GOOD' }),
            );
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            await assert.rejects(fetcher.secretCallback(req, tokenFor('bad-kid')));
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('good-kid')), 'GOOD');
            assert.strictEqual(fetchCalls.length, 2);
        });

        test('every 4xx from the key server is negatively cached', async () => {
            for (const status of [400, 401, 403, 404, 410, 429, 499]) {
                fetchCalls = [];
                stubGot(() => Promise.reject(httpError(status)));
                const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);
                await assert.rejects(fetcher.secretCallback(req, tokenFor('kid')), new RegExp(`${status}`));
                await assert.rejects(fetcher.secretCallback(req, tokenFor('kid')), /failed to fetch public key/);
                assert.strictEqual(fetchCalls.length, 1, `status ${status}`);
            }
        });

        test('a 503 from the key server is not negatively cached: the next call refetches and succeeds', async () => {
            let shouldFail = true;
            stubGot(() => (shouldFail ? Promise.reject(httpError(503)) : Promise.resolve({ body: 'PEM-OK' })));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);
            const kid = 'blip-kid';

            await assert.rejects(fetcher.secretCallback(req, tokenFor(kid)), (err) => {
                assert.strictEqual(err.code, 'invalid_token');
                assert.strictEqual(err.message, 'Response code 503');
                return true;
            });
            assert.strictEqual(fetchCalls.length, 1);
            assert.strictEqual(logger.error.mock.callCount(), 1);
            assert.strictEqual(logger.error.mock.calls[0].arguments[1].negativelyCached, false);

            // No time passes: the very next request goes back to the key server.
            shouldFail = false;
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor(kid)), 'PEM-OK');
            assert.strictEqual(fetchCalls.length, 2);
            const shortCircuits = logger.debug.mock.calls.filter((c) =>
                String(c.arguments[0]).includes('recently failed for kid'),
            );
            assert.strictEqual(shortCircuits.length, 0);
        });

        test('5xx and 3xx HTTP errors are all treated as transient', async () => {
            for (const status of [500, 502, 503, 504, 302]) {
                fetchCalls = [];
                let shouldFail = true;
                stubGot(() => (shouldFail ? Promise.reject(httpError(status)) : Promise.resolve({ body: 'PEM' })));
                const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);
                await assert.rejects(fetcher.secretCallback(req, tokenFor('kid')));
                shouldFail = false;
                assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid')), 'PEM', `status ${status}`);
                assert.strictEqual(fetchCalls.length, 2, `status ${status}`);
            }
        });

        test('a network error (ECONNRESET) is not negatively cached: the next call refetches', async () => {
            let shouldFail = true;
            const reset = Object.assign(new Error('read ECONNRESET'), { name: 'RequestError', code: 'ECONNRESET' });
            stubGot(() => (shouldFail ? Promise.reject(reset) : Promise.resolve({ body: 'PEM-OK' })));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            await assert.rejects(fetcher.secretCallback(req, tokenFor('kid-1')), /ECONNRESET/);
            shouldFail = false;
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'PEM-OK');
            assert.strictEqual(fetchCalls.length, 2);
        });

        test('a transient failure at the positive-cache expiry boundary does not lock the kid out', async () => {
            mock.timers.enable({ apis: ['Date'], now: Date.now() });
            let mode = 'ok';
            stubGot(() => {
                if (mode === 'fail') {
                    return Promise.reject(httpError(503));
                }
                return Promise.resolve({ body: 'PEM' });
            });
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 30);

            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'PEM');
            // The positive cache entry lapses and the refetch hits a blip...
            mock.timers.tick(31_000);
            mode = 'fail';
            await assert.rejects(fetcher.secretCallback(req, tokenFor('kid-1')), /503/);
            // ...but the request right after is served again instead of being rejected for 60s.
            mode = 'ok';
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('kid-1')), 'PEM');
            assert.strictEqual(fetchCalls.length, 3);
        });
    });

    describe('timeouts', () => {
        test('a key server that never answers surfaces as a rejection once the request timeout elapses', async () => {
            mock.timers.enable({ apis: ['setTimeout'] });
            // Behaves like got's request timeout: hang, then reject after `timeout.request` ms.
            stubGot(
                (_url, options) =>
                    new Promise((_resolve, reject) => {
                        setTimeout(() => {
                            const err = new Error(`Timeout awaiting 'request' for ${options.timeout.request}ms`);
                            err.name = 'TimeoutError';
                            reject(err);
                        }, options.timeout.request);
                    }),
            );
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            let settled = false;
            const pending = fetcher.secretCallback(req, tokenFor('slow-kid')).catch((err) => {
                settled = true;
                return err;
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(fetchCalls.length, 1);
            assert.strictEqual(fetchCalls[0].options.timeout.request, KEY_FETCH_TIMEOUT_MS);

            // Just short of the timeout the request is still hanging...
            mock.timers.tick(KEY_FETCH_TIMEOUT_MS - 1);
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(settled, false);

            // ...and once it fires the caller gets an UnauthorizedError rather than a hang.
            mock.timers.tick(1);
            const err = await pending;
            assert.strictEqual(settled, true);
            assert.strictEqual(err.name, 'UnauthorizedError');
            assert.strictEqual(err.code, 'invalid_token');
            assert.match(err.message, /Timeout awaiting 'request' for 5000ms/);
            assert.strictEqual(err.inner.name, 'TimeoutError');
        });

        test('a timed-out kid is not negatively cached: the next call refetches', async () => {
            let shouldFail = true;
            stubGot(() => (shouldFail ? Promise.reject(timeoutError()) : Promise.resolve({ body: 'PEM-OK' })));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            await assert.rejects(fetcher.secretCallback(req, tokenFor('slow-kid')), /Timeout awaiting request/);
            assert.strictEqual(fetchCalls.length, 1);

            shouldFail = false;
            assert.strictEqual(await fetcher.secretCallback(req, tokenFor('slow-kid')), 'PEM-OK');
            assert.strictEqual(fetchCalls.length, 2);
        });

        test('repeated timeouts keep asking the key server rather than short-circuiting', async () => {
            stubGot(() => Promise.reject(timeoutError()));
            const fetcher = new ASAPPubKeyFetcher(baseUrl, 3600);

            await assert.rejects(fetcher.secretCallback(req, tokenFor('slow-kid')), /Timeout awaiting request/);
            await assert.rejects(fetcher.secretCallback(req, tokenFor('slow-kid')), /Timeout awaiting request/);
            assert.strictEqual(fetchCalls.length, 2);
        });
    });
});
