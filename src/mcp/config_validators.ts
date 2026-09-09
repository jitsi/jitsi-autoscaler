import { makeValidator } from 'envalid';

/** Smallest per-request timeout that leaves the autoscaler API a realistic chance to answer. */
export const MIN_REQUEST_TIMEOUT_MS = 1000;

/**
 * Per-request timeout in milliseconds. `num()` would accept 0 or a negative value, which makes
 * every request abort immediately (or throw on AbortSignal.timeout), so require an integer of at
 * least MIN_REQUEST_TIMEOUT_MS.
 */
export const requestTimeoutMs = makeValidator<number>((input: string) => {
    const value = Number(input);
    if (input.trim() === '' || !Number.isInteger(value) || value < MIN_REQUEST_TIMEOUT_MS) {
        throw new Error(
            `MCP_REQUEST_TIMEOUT_MS must be an integer number of milliseconds >= ${MIN_REQUEST_TIMEOUT_MS}, got "${input}"`,
        );
    }
    return value;
});
