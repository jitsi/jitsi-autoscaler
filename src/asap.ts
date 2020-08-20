import got from 'got';
import sha256 from 'sha256';
import NodeCache from 'node-cache';
import { Request } from 'express';
import { secretType } from 'express-jwt';
import { Logger } from 'winston';

class ASAPPubKeyFetcher {
    private baseUrl: string;
    private ttl: number;
    private cache: NodeCache;
    private logger: Logger;

    constructor(logger: Logger, baseUrl: string, ttl: number) {
        this.logger = logger;
        this.baseUrl = baseUrl;
        this.cache = new NodeCache({ stdTTL: ttl });
        this.pubKeyCallback = this.pubKeyCallback.bind(this);
    }

    /* eslint-disable */
    pubKeyCallback(req: Request, header: any, payload: any, done: (err: any, secret?: secretType) => void): void {
        /* eslint-enable */
        if (!header.kid) {
            done(new Error('kid is required in header'), null);
            return;
        }

        const pubKey: string = this.cache.get(header.kid);

        if (pubKey) {
            this.logger.debug('using pub key from cache');
            done(null, pubKey);
        }

        this.logger.debug('fetching pub key from key server');
        fetchPublicKey(this.baseUrl, header.kid)
            .then((pubKey) => {
                this.cache.set(header.kid, pubKey);
                done(null, pubKey);
            })
            .catch((err) => {
                this.logger.error(`obtaining asap pub ${err}`);
                done(err);
            });
    }
}

async function fetchPublicKey(baseUrl: string, kid: string): Promise<string> {
    const hashedKid = sha256(kid);
    const reqUrl = `${baseUrl}/${hashedKid}.pem`;
    const response = await got(reqUrl);
    return response.body;
}

export default ASAPPubKeyFetcher;
