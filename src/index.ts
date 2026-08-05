/**
 * quadra-data — the read layer.
 *
 * An off-chain SQLite mirror of the Flare markets plus the readers that fill and serve it.
 * It exists because Coston2's public RPC caps `eth_getLogs` at 30 blocks: a leaderboard or a
 * job history assembled live costs hundreds of requests and gets rate-limited, so the same
 * walk is done once by the indexer and answered from disk thereafter.
 *
 * Nothing here is authoritative. Every row is derived from a log the chain already emitted,
 * and every value can be re-read from the contract. A verifier must never take this package's
 * word for anything — that is `quadra-verify`'s job, and it reads calldata, not this index.
 */

export {
    loadConfig,
    explainMissing,
    txUrl,
    addressUrl,
    type DataConfig,
    type ConfigResult,
    type ConfigSource,
} from './config.js';
export { loadDotEnv } from './config/dotenv.js';
export { Cached, KeyedCache, warmAll, type CachedOptions, type WarmResult } from './cache.js';
