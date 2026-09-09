import got from 'got';
import sha256 from 'sha256';
import NodeCache from 'node-cache';
import { Request } from 'express';
import { UnauthorizedError } from 'express-jwt';
import jwt from 'jsonwebtoken';

// How long to wait for the key server before giving up on a single request.
const KEY_FETCH_TIMEOUT_MS = 5000;
// How long a definitively rejected kid (key server answered 4xx) is remembered before the key server
// is asked again. This keeps a flood of requests bearing an unknown kid from hammering the key server.
// Transient failures (timeouts, network errors, 5xx) are deliberately not remembered: a single blip at
// the positive-cache expiry boundary must not lock out every token sharing that kid for a minute.
const FAILED_KID_TTL_SEC = 60;

// A got HTTPError whose response status is 4xx: the key server has definitively said it has no such key.
export function isDefinitiveKeyServerRejection(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
        return false;
    }
    const httpErr = err as { name?: string; response?: { statusCode?: number } };
    const status = httpErr.response?.statusCode;
    return httpErr.name === 'HTTPError' && typeof status === 'number' && status >= 400 && status <= 499;
}

export class ASAPPubKeyFetcher {
    private baseUrl: string;
    private cache: NodeCache;
    private failedKids: NodeCache;
    private inFlight: Map<string, Promise<string>>;

    constructor(baseUrl: string, ttl: number) {
        this.baseUrl = baseUrl;
        this.cache = new NodeCache({ stdTTL: ttl });
        this.failedKids = new NodeCache({ stdTTL: FAILED_KID_TTL_SEC });
        this.inFlight = new Map();
        this.secretCallback = this.secretCallback.bind(this);
    }

    async secretCallback(req: Request, token: jwt.Jwt): Promise<jwt.Secret> {
        if (!token || !token.header) {
            throw new UnauthorizedError('credentials_bad_format', new Error('token could not be decoded'));
        }
        if (!token.header.kid) {
            throw new UnauthorizedError('credentials_bad_format', new Error('kid is required in the header'));
        }
        const kid = token.header.kid;

        const pubKey = <jwt.Secret>this.cache.get(kid);
        if (pubKey) {
            req.context.logger.debug('using pub key from cache');
            return pubKey;
        }

        const recentFailure = this.failedKids.get<string>(kid);
        if (recentFailure) {
            req.context.logger.debug('pub key fetch recently failed for kid, rejecting without refetch', { kid });
            throw new UnauthorizedError('invalid_token', new Error(recentFailure));
        }

        try {
            const fetched = <jwt.Secret>await this.fetchCoalesced(kid);
            req.context.logger.debug('success, caching pubkey for kid', { kid });
            this.cache.set(kid, fetched);
            return fetched;
        } catch (err) {
            const definitive = isDefinitiveKeyServerRejection(err);
            req.context.logger.error('error fetching pub key from key server', {
                baseUrl: this.baseUrl,
                kid,
                err,
                negativelyCached: definitive,
            });
            if (definitive) {
                this.failedKids.set(kid, `failed to fetch public key for kid ${kid}: ${err}`);
            }
            throw new UnauthorizedError('invalid_token', err);
        }
    }

    // Concurrent requests for the same kid share one outbound fetch.
    private fetchCoalesced(kid: string): Promise<string> {
        const existing = this.inFlight.get(kid);
        if (existing) {
            return existing;
        }
        const pending = fetchPublicKey(this.baseUrl, kid).finally(() => {
            this.inFlight.delete(kid);
        });
        this.inFlight.set(kid, pending);
        return pending;
    }
}

async function fetchPublicKey(baseUrl: string, kid: string): Promise<string> {
    const hashedKid = sha256(kid);
    const reqUrl = `${baseUrl}/${hashedKid}.pem`;
    const response = await got(reqUrl, { timeout: { request: KEY_FETCH_TIMEOUT_MS }, retry: { limit: 1 } });
    return response.body;
}
