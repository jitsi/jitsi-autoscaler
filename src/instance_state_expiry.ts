import { Context } from './context';
import { InstanceState } from './instance_store';

export interface StateExpiryTTLs {
    idleTTL: number;
    provisioningTTL: number;
    shutdownStatusTTL: number;
}

/**
 * Single source of the instance-state expiry policy, shared by RedisStore and ConsulStore so the two
 * cannot drift. Partitions states into still-valid and expired using: provisioning states -> provisioningTTL,
 * shutting-down states -> shutdownStatusTTL, everything else -> idleTTL. A state without a timestamp is
 * treated as expired (and logged) rather than relying on a NaN comparison. Callers delete the expired
 * states with their own store primitive.
 */
export function partitionExpiredStates(
    ctx: Context,
    group: string,
    states: InstanceState[],
    shutdownStatuses: boolean[],
    ttls: StateExpiryTTLs,
    now: number,
): { valid: InstanceState[]; expired: InstanceState[] } {
    const valid: InstanceState[] = [];
    const expired: InstanceState[] = [];
    for (let i = 0; i < states.length; i++) {
        const state = states[i];
        let statusTTL = ttls.idleTTL;
        if (state.status && state.status.provisioning) {
            statusTTL = ttls.provisioningTTL;
        }
        // We keep shutdown status a bit longer, to be consistent with the Oracle Search API, which has a
        // delay in seeing Terminating status.
        if (state.isShuttingDown || shutdownStatuses[i]) {
            statusTTL = ttls.shutdownStatusTTL;
        }

        let isValid: boolean;
        if (state.timestamp === undefined || state.timestamp === null) {
            ctx.logger.warn(`state has no timestamp, treating as expired`, { group, state });
            isValid = false;
        } else {
            isValid = state.timestamp + 1000 * statusTTL >= now;
        }

        if (isValid) {
            valid.push(state);
        } else {
            expired.push(state);
        }
    }
    return { valid, expired };
}
