/**
 * quadra-core — the pure, deterministic core.
 *
 * Everything exported here is a total function of its arguments: no chain reads, no clock, no
 * secrets. That is what makes a settlement replayable — anyone holding the published receipt and
 * the public chain state can recompute the score and the digest and get byte-identical results,
 * without trusting whoever ran the evaluation.
 *
 * This entry point is also what the evaluation engine's TEE image compiles in, so its dependency
 * graph is part of the measured code hash. Keep it to viem and the two ECIES libraries; a native
 * dependency here means the same source produces a different image hash on every build machine.
 *
 * Two things ship behind subpath exports instead of here:
 *   - `quadra-core/ground-truth` performs HTTP against Flare's DA layer.
 *   - `quadra-core/verify` is the replay logic, which only a verifier needs.
 */

export * from './scorers/index.js';
export * from './eip712.js';
export * from './receipt.js';
export * from './envelope.js';
export * from './ecies.js';
export * from './jobParams.js';
export * from './templates.js';
export {
    getLogsChunked,
    logChunkSize,
    isTransient,
    withRetry,
    DEFAULT_LOG_CHUNK,
    type ChunkedLogsArgs,
} from './logs.js';
export { withWriteLock } from './writeLock.js';
