import { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Shared tool annotation presets. All tools talk to a single, known autoscaler
 * deployment, so none of them are "open world".
 */
export const READ_ONLY: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

/** Additive/updating writes that can be safely repeated with the same arguments. */
export const IDEMPOTENT_WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

/** Writes whose repeat invocation is rejected or changes state again (e.g. "extend from now"). */
export const NON_IDEMPOTENT_WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

/** Writes that can remove or overwrite existing state. */
export const DESTRUCTIVE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
};
