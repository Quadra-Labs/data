/**
 * feeds.ts — the FTSO addressing and unit rules.
 *
 * Which feed does a job resolve against, which voting round answers a given timestamp, and how
 * does a raw feed reading become the 1e-8 fixed-point price the scorers and the contracts both
 * use. All pure, all integer, and all of it needed by three parties who must agree: the TEE that
 * signs a settlement, the contract that re-checks it, and the verifier that replays it.
 *
 * It lives in the core rather than in the evaluation engine because the VERIFIER needs it, and a
 * verifier that imports the workload it audits is not an independent check.
 */

import { stringToHex, pad, type Hex } from 'viem';

/**
 * The voting-epoch geometry: anchor feeds finalize every 90 seconds, and round 0 began here.
 *
 * These are the **Coston2-confirmed fallback**, not an authority. Flare's own docs publish
 * `1658429955` for a sibling network, and `FlareSystemsManager` is where the real values live —
 * `resolveVotingEpoch` in `quadra-core/voting-epoch` reads them and warns loudly on divergence.
 *
 * Getting this wrong is the quiet kind of wrong: `votingRoundIdForTimestamp` returns a plausible
 * round, the DA layer answers with a real finalized feed, the Merkle proof verifies on chain, and
 * the settlement is scored against the wrong INSTANT. Nothing reports an error anywhere.
 */
export const FIRST_VOTING_ROUND_UNIX = 1_658_430_000;
export const VOTING_EPOCH_SECS = 90;

/** The two numbers that place a timestamp in a voting round. */
export interface VotingEpoch {
    readonly firstVotingRoundUnix: number;
    readonly epochSecs: number;
}

/** The compiled-in geometry, as a value the parameterized functions below can take. */
export const FALLBACK_VOTING_EPOCH: VotingEpoch = {
    firstVotingRoundUnix: FIRST_VOTING_ROUND_UNIX,
    epochSecs: VOTING_EPOCH_SECS,
};

/** The app's canonical price precision (1e-8 fixed point). MUST match `FtsoLib.PRICE_DECIMALS`. */
export const PRICE_DECIMALS = 8;

/** The widest raw reading the on-chain `FeedData.value` (an int32) can carry. */
export const MAX_INT32 = 2_147_483_647;

/** The voting round whose finalized value resolves a target time, under a given epoch geometry. */
export function votingRoundIdForTimestampIn(epoch: VotingEpoch, unixSeconds: number): number {
    return Math.floor((unixSeconds - epoch.firstVotingRoundUnix) / epoch.epochSecs);
}

/** The unix second a voting round opened, under a given epoch geometry. */
export function votingRoundStartUnixIn(epoch: VotingEpoch, votingRoundId: number): number {
    return epoch.firstVotingRoundUnix + votingRoundId * epoch.epochSecs;
}

/**
 * The voting round whose finalized value resolves a target time.
 *
 * Zero-config form, using the compiled-in fallback. Every existing caller keeps working; a caller
 * that has resolved the real geometry from chain passes it to the `...In` form above instead.
 */
export function votingRoundIdForTimestamp(unixSeconds: number): number {
    return votingRoundIdForTimestampIn(FALLBACK_VOTING_EPOCH, unixSeconds);
}

/** The unix second a voting round opened. The inverse of the above, for human-readable output. */
export function votingRoundStartUnix(votingRoundId: number): number {
    return votingRoundStartUnixIn(FALLBACK_VOTING_EPOCH, votingRoundId);
}

/**
 * Build a crypto FTSO feed id (bytes21): category byte 0x01, then the pair in ASCII, right-padded
 * with zeros. Verified against Flare's published list — `cryptoFeedId('BTC/USD')` produces
 * `0x014254432f55534400000000000000000000000000`, which is the id in their own documentation.
 */
export function cryptoFeedId(pair: string): Hex {
    const nameHex = stringToHex(pair).slice(2);
    return pad(`0x01${nameHex}`, { size: 21, dir: 'right' });
}

/** The feeds this build can resolve against. */
export const FEED_IDS = {
    'BTC/USD': cryptoFeedId('BTC/USD'),
    'ETH/USD': cryptoFeedId('ETH/USD'),
    'SOL/USD': cryptoFeedId('SOL/USD'),
    'XRP/USD': cryptoFeedId('XRP/USD'),
    'FLR/USD': cryptoFeedId('FLR/USD'),
} as const;

export type FeedSymbol = keyof typeof FEED_IDS;

export function isFeedSymbol(value: string): value is FeedSymbol {
    return value in FEED_IDS;
}

/**
 * Which FTSO feed to resolve an item against. The item's OWN asset wins over the evaluator's
 * default: several agents share one evaluator (every price-band bot uses `price-range-guess`), so
 * resolving by evaluator alone would score an ETH forecast against the BTC feed — a guaranteed
 * zero for an agent that was right.
 *
 * `fallback` supplies the evaluator's default, used for competitions and for jobs whose params
 * declare no asset.
 */
export function feedFor(
    evaluatorId: string,
    asset: string | undefined,
    fallback: (evaluatorId: string) => FeedSymbol,
): FeedSymbol {
    const symbol = asset ? `${asset}/USD` : undefined;
    if (symbol !== undefined && isFeedSymbol(symbol)) return symbol;
    return fallback(evaluatorId);
}

/** The on-chain FtsoV2 `FeedDataWithProof` tuple, shaped for viem's writeContract args. */
export interface FeedDataWithProof {
    readonly proof: readonly Hex[];
    readonly body: {
        readonly votingRoundId: number;
        readonly id: Hex;
        /** int32, in `decimals`. */
        readonly value: number;
        readonly turnoutBPS: number;
        /** int8. */
        readonly decimals: number;
    };
}

/**
 * Normalize a raw FTSO reading (in the feed's own `decimals`) to the app's 1e-8 fixed point.
 *
 * This mirrors `FtsoLib.normalizedPrice` exactly, INCLUDING its rejections. The Flare reference
 * silently truncated when `decimals > 8` and happily produced a negative price, where the Solidity
 * reverts `BadFtsoDecimals` / `BadFtsoProof`. That divergence does not fail where you would look
 * for it: the TEE would sign a `groundTruthValue` the contract can never accept, so the settlement
 * reverts with an oracle error and the enclave looks correct. Failing here instead makes the
 * problem visible at the point it is created.
 *
 * Feed decimals really do vary — Flare's own example has BTC/USD at 2 — so this path matters.
 */
export function normalizeToPrice(value: number, decimals: number): bigint {
    if (!Number.isInteger(value) || !Number.isInteger(decimals)) {
        throw new Error(`feeds: non-integer FTSO reading (value=${value}, decimals=${decimals})`);
    }
    if (value < 0) {
        throw new Error(`feeds: negative FTSO value (${value}); FtsoLib rejects this on chain`);
    }
    // The on-chain FeedData.value is int32, so Solidity gets this bound from the type and a larger
    // number would have wrapped to a negative before it ever reached normalizedPrice. TypeScript
    // has no such type, so the bound is explicit here or the two sides disagree on inputs no real
    // feed can produce.
    //
    // The ceiling is why feed decimals shrink as a price grows: int32 max at PRICE_DECIMALS is
    // only ~$21.47, which is exactly why Flare publishes BTC/USD at decimals 2. Normalizing back
    // up to a uniform 1e-8 is this function's whole job.
    if (value > MAX_INT32) {
        throw new Error(
            `feeds: FTSO value ${value} exceeds the int32 the on-chain FeedData holds ` +
                `(max ${MAX_INT32}); a real feed lowers its decimals rather than exceeding this`,
        );
    }
    if (decimals < 0 || decimals > PRICE_DECIMALS) {
        throw new Error(
            `feeds: FTSO decimals ${decimals} outside the supported [0, ${PRICE_DECIMALS}] range; ` +
                'FtsoLib reverts BadFtsoDecimals, so a value scaled here could never settle',
        );
    }
    return BigInt(value) * 10n ** BigInt(PRICE_DECIMALS - decimals);
}
