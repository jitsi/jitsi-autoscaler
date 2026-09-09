import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync } from 'node:crypto';

export interface TempOciConfig {
    dir: string;
    configPath: string;
}

/**
 * Write a throwaway OCI config file backed by a freshly generated RSA key so that OCI SDK
 * clients can be constructed offline. A placeholder key is not enough: the SDK parses the
 * private key as soon as a request signer is built (i.e. when any client is constructed).
 * Callers should remove `dir` when done.
 */
export function writeTempOciConfig(profile = 'DEFAULT'): TempOciConfig {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoscaler-oci-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = path.join(dir, 'key.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const configPath = path.join(dir, 'config');
    fs.writeFileSync(
        configPath,
        [
            `[${profile}]`,
            'user=ocid1.user.oc1..aaaaaaaatest',
            'fingerprint=aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
            'tenancy=ocid1.tenancy.oc1..aaaaaaaatest',
            'region=us-phoenix-1',
            `key_file=${keyPath}`,
            '',
        ].join('\n'),
    );
    return { dir, configPath };
}
