/**
 * groundTruth.ts — fetching a finalized FTSO anchor reading and its Merkle proof from Flare's DA
 * layer.
 *
 * At resolution the engine fetches the finalized price for the target voting round, normalizes it
 * to 1e-8, and hands the raw `FeedDataWithProof` to `settle` / `scoreJob`, which re-verify that
 * proof on chain against FtsoV2. That is the second half of "double verification": the TEE says
 * what the price was, and the contract checks the oracle's own signature on it.
 *
 * This module is the ONLY part of the core that performs network I/O, which is why it ships behind
 * the `quadra-core/ground-truth` subpath instead of the main entry — the pure entry's promise that
 * it does no I/O is worth keeping literally true, and the TEE image should not pull an HTTP client
 * into its measured code unless it is actually used.
 *
 * The request and response shapes are verified against Flare's published documentation: a POST to
 * `/api/v0/ftso/anchor-feeds-with-proof` with the round as a QUERY parameter and `{feed_ids: [...]}`
 * as the body, answered with an array of `{body: {votingRoundId, id, value, turnoutBIPS, decimals},
 * proof: []}`. What is NOT verified is the Coston2 host name and whether the public endpoint
 * requires an API key.
 */

import type { Hex } from 'viem';

import {
    normalizeToPrice,
    type FeedDataWithProof,
    votingRoundIdForTimestamp,
    FEED_IDS,
    feedFor,
    type FeedSymbol,
} from './feeds.js';
import type { GroundTruth } from './receipt.js';

export {
    normalizeToPrice,
    votingRoundIdForTimestamp,
    votingRoundStartUnix,
    cryptoFeedId,
    FEED_IDS,
    PRICE_DECIMALS,
    FIRST_VOTING_ROUND_UNIX,
    VOTING_EPOCH_SECS,
    feedFor,
    isFeedSymbol,
    type FeedSymbol,
    type FeedDataWithProof,
} from './feeds.js';

/** The DA-layer base URL for Coston2. */
export const COSTON2_DA_URL = 'https://ctn2-data-availability.flare.network';

export interface ResolvedGroundTruth {
    /** The price normalized to 1e-8 — the scorers' input and the signed `groundTruthValue`. */
    readonly value: bigint;
    /** The raw feed and Merkle proof, to pass to settle* for the on-chain re-check. */
    readonly feed: FeedDataWithProof;
    /** The receipt's record of it, re-fetchable by anyone replaying the settlement. */
    readonly groundTruth: GroundTruth;
}

/** A minimal fetch shape, injected so the whole module is testable without network. */
export type FetchLike = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface RawAnchorFeed {
    readonly body?: {
        readonly votingRoundId?: number;
        readonly id?: string;
        readonly value?: number;
        /** Flare's documented spelling. */
        readonly turnoutBIPS?: number;
        /** The Solidity struct's spelling, accepted as a fallback. */
        readonly turnoutBPS?: number;
        readonly decimals?: number;
    };
    readonly proof?: readonly string[];
}

/**
 * Pull the requested feed out of the DA layer's response.
 *
 * Matches on the feed id rather than taking the first element: the endpoint accepts several feeds
 * per request and answers with an array, so position is not a contract.
 *
 * A mismatch is a fault, never a convenience, so there is deliberately no fall back to the first
 * element. Scoring an ETH forecast against the BTC anchor is the worst failure available here: the
 * Merkle proof still verifies on chain (it is a real feed at a real round) and `checkGroundTruth`
 * still matches the signed value (the TEE signed the same wrong number), so the settlement
 * succeeds and the score is permanently, verifiably wrong with nothing to point at.
 */
export function parseAnchorFeed(raw: unknown, feedId: Hex): FeedDataWithProof {
    const list = Array.isArray(raw) ? (raw as RawAnchorFeed[]) : [raw as RawAnchorFeed];
    const want = feedId.toLowerCase();
    const match = list.find((f) => f.body?.id?.toLowerCase() === want);
    if (!match) {
        const got = list.map((f) => f.body?.id ?? '<no id>').join(', ');
        throw new Error(
            `ground-truth: asked the DA layer for feed ${feedId} but it answered with [${got}]; ` +
                'scoring against a different asset would settle a wrong result that still verifies on chain',
        );
    }
    const body = match.body;
    if (
        !body ||
        body.value === undefined ||
        body.decimals === undefined ||
        body.votingRoundId === undefined
    ) {
        throw new Error(
            'ground-truth: unexpected DA-layer response shape (expected an array of ' +
                '{body:{votingRoundId,id,value,turnoutBIPS,decimals},proof:[]})',
        );
    }
    return {
        proof: (match.proof ?? []).map((p) => p as Hex),
        body: {
            votingRoundId: body.votingRoundId,
            // `body.id`, not `?? feedId`: the match above already proves they are equal, and
            // relabelling with the REQUESTED id is precisely what let a wrong feed through
            // wearing the right name.
            id: body.id as Hex,
            value: body.value,
            // The DA layer returns `turnoutBIPS`; the Solidity struct field is `turnoutBPS`.
            // Reading the wrong one silently yields 0, which breaks the on-chain Merkle proof —
            // the leaf covers this field, so a zeroed turnout hashes to a different leaf and
            // `verifyFeedData` fails with nothing to point at.
            turnoutBPS: body.turnoutBIPS ?? body.turnoutBPS ?? 0,
            decimals: body.decimals,
        },
    };
}

export interface GroundTruthArgs {
    readonly daBaseUrl: string;
    readonly feedId: Hex;
    readonly votingRoundId: number;
    /** Some DA deployments require `X-API-KEY`; the public Coston2 endpoint may not. */
    readonly apiKey?: string | undefined;
    readonly fetchImpl?: FetchLike | undefined;
}

/** Fetch and package the finalized FTSO ground truth for `feedId` at `votingRoundId`. */
export async function fetchGroundTruth(args: GroundTruthArgs): Promise<ResolvedGroundTruth> {
    const fetchImpl = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    // The voting round MUST go in the query string. Sent in the body it is silently ignored and
    // the API answers with the LATEST finalized round instead — which makes settlement
    // non-deterministic and breaks replay outright, because a verifier re-fetching an hour later
    // gets a different price and reports the settlement as wrong.
    const url = `${args.daBaseUrl}/api/v0/ftso/anchor-feeds-with-proof?voting_round_id=${args.votingRoundId}`;
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(args.apiKey ? { 'X-API-KEY': args.apiKey } : {}),
        },
        body: JSON.stringify({ feed_ids: [args.feedId] }),
    });
    if (!res.ok) throw new Error(`ground-truth: DA layer returned ${res.status}`);

    const feed = parseAnchorFeed(await res.json(), args.feedId);
    if (feed.body.votingRoundId !== args.votingRoundId) {
        // The failure mode the query-param note above describes, caught rather than assumed.
        throw new Error(
            `ground-truth: asked for voting round ${args.votingRoundId} but the DA layer ` +
                `answered with ${feed.body.votingRoundId}; a settlement built on this would not replay`,
        );
    }

    const value = normalizeToPrice(feed.body.value, feed.body.decimals);
    const groundTruth: GroundTruth = {
        kind: 'ftso-anchor',
        feedId: feed.body.id,
        votingRoundId: feed.body.votingRoundId,
        value: String(feed.body.value),
        decimals: feed.body.decimals,
    };
    return { value, feed, groundTruth };
}

export interface ResolveConfig {
    readonly daBaseUrl: string;
    /** The evaluator's default feed, used when the item declares no asset of its own. */
    readonly feedForEvaluator: (evaluatorId: string) => FeedSymbol;
    /** The fallback scored window, used when the item's real window is unknown. */
    readonly defaultLifetimeSecs: number;
    readonly apiKey?: string | undefined;
    readonly fetchImpl?: FetchLike | undefined;
}

/**
 * Resolve the end price (at resolution) and the start price (one lifetime earlier, which sets the
 * scorer's tolerance) from the anchor feed this item resolves against.
 *
 * `lifetimeSecs` does double duty: it picks the start round, and the price-range scorer sizes its
 * grace band by sqrt of it. Pass the item's real window whenever it is knowable — a paid job knows
 * exactly when it was paid — and let the config default cover competitions, which have no
 * per-entrant start.
 */
export async function resolveInputs(
    config: ResolveConfig,
    evaluatorId: string,
    resolveAtSecs: number,
    asset?: string,
    windowSecs?: number,
): Promise<{ end: ResolvedGroundTruth; startValue: bigint; lifetimeSecs: number }> {
    const feedId = FEED_IDS[feedFor(evaluatorId, asset, config.feedForEvaluator)];
    const lifetimeSecs =
        windowSecs !== undefined && windowSecs > 0 ? windowSecs : config.defaultLifetimeSecs;
    const common = {
        daBaseUrl: config.daBaseUrl,
        feedId,
        apiKey: config.apiKey,
        fetchImpl: config.fetchImpl,
    };
    const end = await fetchGroundTruth({
        ...common,
        votingRoundId: votingRoundIdForTimestamp(resolveAtSecs),
    });
    const start = await fetchGroundTruth({
        ...common,
        votingRoundId: votingRoundIdForTimestamp(resolveAtSecs - lifetimeSecs),
    });
    return { end, startValue: start.value, lifetimeSecs };
}
