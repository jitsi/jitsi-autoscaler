import got from 'got';
import sha256 from 'sha256';
import NodeCache from 'node-cache';
import { Request } from 'express';
import jwt from 'jsonwebtoken';

export class ASAPPubKeyFetcher {
    private baseUrl: string;
    private ttl: number;
    private cache: NodeCache;

    constructor(baseUrl: string, ttl: number) {
        this.baseUrl = baseUrl;
        this.cache = new NodeCache({ stdTTL: ttl });
        this.secretCallback = this.secretCallback.bind(this);
    }

    async secretCallback(req: Request, token: jwt.Jwt): Promise<jwt.Secret> {
        if (!token.header.kid) {
            throw new Error('kid is required in header');
        }

        let pubKey = <jwt.Secret>this.cache.get(token.header.kid);

        if (pubKey) {
            req.context.logger.debug('using pub key from cache');
            return pubKey;
        }

        req.context.logger.debug('fetching pub key from key server');
        pubKey = <jwt.Secret>await fetchPublicKey(this.baseUrl, token.header.kid);
        this.cache.set(token.header.kid, pubKey);

        return pubKey;
    }
}

async function fetchPublicKey(baseUrl: string, kid: string): Promise<string> {
    const hashedKid = sha256(kid);
    const reqUrl = `${baseUrl}/${hashedKid}.pem`;
    const response = await got(reqUrl);
    return response.body;
}
