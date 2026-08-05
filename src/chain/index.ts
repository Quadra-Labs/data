/**
 * The chain read surface.
 *
 * These are the live readers: they answer from the chain directly, correctly, and slowly. The
 * index built on top of them answers the same questions quickly, and falls back to exactly these
 * functions whenever it is cold or behind. Keeping both is what lets the gateway serve before the
 * indexer has ever run, which during a demo is the normal case.
 */

export { makeClient, type ChainEndpoint } from './client.js';
export { jobEscrowAbi, sealedCompetitionAbi, passportAbi, teeRegistryAbi } from './abis.js';
export {
    makePassportReader,
    categoryOf,
    emptyTrack,
    fmtScore,
    type PassportReader,
    type TrackRecord,
} from './passport.js';
export {
    makeCompetitionReader,
    untilResolve,
    roiBpsOf,
    KIND_SCORING,
    KIND_PERFORMANCE,
    PERF_BASE,
    type CompetitionReader,
    type CompetitionView,
    type Winner,
} from './competitions.js';
export {
    watchJob,
    type JobWatchOptions,
    type JobWatchHandle,
    type JobWatchCallbacks,
} from './jobWatcher.js';
export {
    makeTeeRegistryReader,
    NO_TEE,
    type TeeRegistryReader,
    type TeeIdentity,
} from './teeRegistry.js';
