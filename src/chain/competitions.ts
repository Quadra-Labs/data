/**
 * competitions.ts — the other market.
 *
 * A paid job is one buyer and one agent. A competition is many agents staking into one prize, each
 * submitting a prediction nobody can read while it runs, all scored by the same TEE at the same
 * instant against the same oracle. That symmetry is the point: it is the only setting where the
 * Passport leaderboard means much, because it is the only place agents are graded on identical
 * inputs.
 *
 * Read-only. Creating a competition funds a prize and is an operator action; joining and
 * submitting belong to the agent runtime.
 */

import type { Address, Hex, PublicClient } from 'viem';
import { getLogsChunked } from 'quadra-core';

import { sealedCompetitionAbi } from './abis.js';

/**
 * How far back to hunt for a competition's creation log when its block is unknown. Bounded because
 * every window is an RPC round trip; anything older than this should be served from the index.
 */
const CREATION_SEARCH_BLOCKS = 6_000n;

/** Resolution modes, mirroring the contract's constants. */
export const KIND_SCORING = 0;
export const KIND_PERFORMANCE = 1;

/** Zero-ROI baseline for a performance metric: `metric = PERF_BASE + roi_bps`. */
export const PERF_BASE = 1_000_000n;

export interface Winner {
    readonly agent: Address;
    readonly rank: number;
    readonly amount: bigint;
}

export interface CompetitionView {
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    readonly category: Hex;
    /** KIND_SCORING or KIND_PERFORMANCE. Decides how to READ the ranking values below. */
    readonly kind: number;
    readonly stake: bigint;
    /** The creator's own funding, refundable if the competition is cancelled. */
    readonly seedPrize: bigint;
    readonly stakedTotal: bigint;
    /**
     * What the contract still holds. After settlement this is only unclaimed dust — the pool is
     * drained to the winners — so it is NOT the number to show for a finished competition.
     */
    readonly prizePool: bigint;
    /** Total actually paid out. Zero until settled. This is the prize a person means. */
    readonly awarded: bigint;
    readonly resolveAt: number;
    readonly threshold: bigint;
    readonly settled: boolean;
    readonly cancelled: boolean;
    readonly creator: Address;
    /** The winner split in percent, summing to 100. Length is the number of winner slots. */
    readonly splitPct: readonly number[];
    /**
     * Agents that have submitted a sealed prediction. Their CONTENT stays sealed until settlement;
     * this is only who is in, which is public by design.
     */
    readonly entrants: readonly Address[];
    /** Empty until settled. */
    readonly winners: readonly Winner[];
}

export interface CompetitionReader {
    /** Competitions created within the last `lookbackBlocks`, newest first. */
    recent(lookbackBlocks: bigint): Promise<CompetitionView[]>;
    /** One competition by id, with its entrants and, once settled, its winners. */
    get(competitionId: Hex, createdBlock?: bigint): Promise<CompetitionView | undefined>;
}

const totalAwarded = (winners: readonly Winner[]): bigint =>
    winners.reduce((t, w) => t + w.amount, 0n);

/** Decode a performance metric back to basis points of return. Negative below PERF_BASE. */
export function roiBpsOf(metric: bigint): number {
    return Number(metric - PERF_BASE);
}

export function makeCompetitionReader(
    client: PublicClient,
    sealedCompetition: Address,
): CompetitionReader {
    /** Who submitted, and who won. Both are bounded log scans against the competition id. */
    async function participants(
        competitionId: Hex,
        fromBlock: bigint,
    ): Promise<{ entrants: Address[]; winners: Winner[] }> {
        const [submitted, prizes] = await Promise.all([
            getLogsChunked({
                client,
                fromBlock,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: sealedCompetition,
                        abi: sealedCompetitionAbi,
                        eventName: 'Submitted',
                        args: { competitionId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            }),
            getLogsChunked({
                client,
                fromBlock,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: sealedCompetition,
                        abi: sealedCompetitionAbi,
                        eventName: 'PrizeAwarded',
                        args: { competitionId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            }),
        ]);

        const seen = new Set<string>();
        const entrants: Address[] = [];
        for (const l of submitted) {
            const a = l.args.agent;
            if (a && !seen.has(a.toLowerCase())) {
                seen.add(a.toLowerCase());
                entrants.push(a);
            }
        }
        const winners: Winner[] = prizes
            .filter((l) => l.args.agent !== undefined && l.args.amount !== undefined)
            .map((l) => ({
                agent: l.args.agent as Address,
                rank: Number(l.args.rank ?? 0n),
                amount: l.args.amount as bigint,
            }))
            .sort((a, b) => a.rank - b.rank);

        return { entrants, winners };
    }

    async function readState(
        competitionId: Hex,
    ): Promise<Omit<CompetitionView, 'entrants' | 'winners' | 'awarded'> | undefined> {
        const [r, splitPct] = await Promise.all([
            client.readContract({
                address: sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'competitions',
                args: [competitionId],
            }),
            client
                .readContract({
                    address: sealedCompetition,
                    abi: sealedCompetitionAbi,
                    functionName: 'getSplit',
                    args: [competitionId],
                })
                .catch(() => [] as readonly number[]),
        ]);

        const [
            evaluatorId,
            category,
            kind,
            stake,
            seedPrize,
            stakedTotal,
            prizePool,
            resolveAt,
            threshold,
            exists,
            settled,
            cancelled,
            creator,
        ] = r;

        // `exists` is an explicit field rather than a sentinel. The Flare reference inferred
        // existence from a non-zero creator, and an earlier version inferred it from a non-zero
        // resolveAt — which is what let a competition be created twice and its funds locked.
        if (!exists) return undefined;

        return {
            competitionId,
            evaluatorId,
            category,
            kind: Number(kind),
            stake,
            seedPrize,
            stakedTotal,
            prizePool,
            resolveAt: Number(resolveAt),
            threshold,
            settled,
            cancelled,
            creator,
            splitPct: [...splitPct],
        };
    }

    return {
        async recent(lookbackBlocks) {
            const head = await client.getBlockNumber();
            const floor = head > lookbackBlocks ? head - lookbackBlocks : 0n;
            const logs = await getLogsChunked({
                client,
                fromBlock: floor,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: sealedCompetition,
                        abi: sealedCompetitionAbi,
                        eventName: 'CompetitionCreated',
                        fromBlock: from,
                        toBlock: to,
                    }),
            });

            const found: Array<{ id: Hex; at: bigint }> = [];
            const seen = new Set<string>();
            for (const l of logs) {
                const id = l.args.competitionId;
                if (id && !seen.has(id)) {
                    seen.add(id);
                    found.push({ id, at: l.blockNumber ?? floor });
                }
            }

            const views: CompetitionView[] = [];
            for (const { id, at } of found.reverse()) {
                const view = await this.get(id, at);
                if (view) views.push(view);
            }
            return views;
        },

        async get(competitionId, createdBlock) {
            const state = await readState(competitionId);
            if (!state) return undefined;

            // Anchor the scan at this competition's OWN creation block: submissions cannot predate
            // it, and every extra window is another rate-limited request. A fixed "look back N
            // blocks" is the trap — at the public RPC's 30-block cap, 50k blocks is 1,600+
            // requests and gets throttled before it returns anything.
            let floor = createdBlock;
            if (floor === undefined) {
                const head = await client.getBlockNumber();
                const searchFloor = head > CREATION_SEARCH_BLOCKS ? head - CREATION_SEARCH_BLOCKS : 0n;
                const created = await getLogsChunked({
                    client,
                    fromBlock: searchFloor,
                    stopAtFirstHit: true,
                    fetch: (from, to) =>
                        client.getContractEvents({
                            address: sealedCompetition,
                            abi: sealedCompetitionAbi,
                            eventName: 'CompetitionCreated',
                            args: { competitionId },
                            fromBlock: from,
                            toBlock: to,
                        }),
                });
                floor = created.at(-1)?.blockNumber ?? searchFloor;
            }

            const { entrants, winners } = await participants(competitionId, floor);
            return { ...state, entrants, winners, awarded: totalAwarded(winners) };
        },
    };
}

/** Seconds until (or since) a competition resolves, in words. */
export function untilResolve(resolveAt: number): string {
    const secs = resolveAt - Math.floor(Date.now() / 1000);
    const abs = Math.abs(secs);
    const unit =
        abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)} min` : `${(abs / 3600).toFixed(1)} h`;
    return secs >= 0 ? `in ${unit}` : `${unit} ago`;
}
