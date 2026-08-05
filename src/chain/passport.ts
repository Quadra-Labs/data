/**
 * passport.ts — reading the on-chain reputation the whole system exists to produce.
 *
 * Every settled job and competition folds a [0,100] score into the agent's Passport track. Two
 * numbers matter and they are not the same:
 *
 *   average   totalScore/scored — what the agent has actually done. Undefined with no results.
 *   overall   the Bayesian reputation the CONTRACT computes (prior 50, confidence 20). A fresh
 *             agent sits at the prior and needs a real body of work before its own record
 *             dominates, so one lucky 100 cannot top the leaderboard. Rank by this; show the
 *             average beside it so the ranking is legible.
 *
 * The contract is authoritative for both. The index mirrors these numbers and never invents its
 * own — the Sui version computed a different Bayesian prior off-chain, so the leaderboard and the
 * chain disagreed about who was first.
 */

import { keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';

import { passportAbi } from './abis.js';

export interface TrackRecord {
    readonly agent: Address;
    /** How many jobs and competitions have been scored in this category. */
    readonly scored: number;
    /** Mean of those scores, 0-100. Undefined when nothing has been scored yet. */
    readonly average: number | undefined;
    readonly best: number;
    /** The contract's Bayesian reputation, 0-100 (it stores x100). */
    readonly overall: number;
    /** 1-based position within the category; 0 when the agent has no track at all. */
    readonly rank: number;
}

/**
 * An agent with no scored work. Shown rather than hidden: "no track record" is real information
 * about someone you are about to pay.
 */
export function emptyTrack(agent: Address): TrackRecord {
    return { agent, scored: 0, average: undefined, best: 0, overall: 50, rank: 0 };
}

/** The Passport category for an evaluator — keccak of its id, exactly as the markets compute it. */
export const categoryOf = (evaluatorId: string): Hex => keccak256(toHex(evaluatorId));

/** Reputation renders to one decimal: whole numbers hide the gap between two agents near the top. */
export const fmtScore = (n: number | undefined): string => (n === undefined ? '—' : n.toFixed(1));

export interface PassportReader {
    /** One agent's record in one category. Never throws: an unreachable chain reads as no track. */
    track(agent: Address, evaluatorId: string): Promise<TrackRecord>;
    /** How many agents have ever been scored in the category. */
    count(evaluatorId: string): Promise<number>;
    /** A page of the category's agents, best first. Never throws; empty on failure. */
    leaderboard(evaluatorId: string, offset?: number, limit?: number): Promise<TrackRecord[]>;
}

/**
 * A page cap for the leaderboard.
 *
 * Each agent costs three contract reads, so a page of 50 is 150 calls against an endpoint that
 * rate-limits. The index serves this far more cheaply once it is warm; this path exists for a
 * cold start and as the fallback, and it must stay bounded to remain useful in that role.
 */
const DEFAULT_PAGE = 50;

export function makePassportReader(client: PublicClient, passport: Address): PassportReader {
    async function readOne(agent: Address, category: Hex): Promise<TrackRecord> {
        const [track, overallX100, rank] = await Promise.all([
            client.readContract({
                address: passport,
                abi: passportAbi,
                functionName: 'getTrack',
                args: [agent, category],
            }),
            client.readContract({
                address: passport,
                abi: passportAbi,
                functionName: 'overall',
                args: [agent, category],
            }),
            client.readContract({
                address: passport,
                abi: passportAbi,
                functionName: 'rank',
                args: [agent, category],
            }),
        ]);
        const [scored, totalScore, best] = track;
        return {
            agent,
            scored: Number(scored),
            average: Number(scored) > 0 ? Number(totalScore) / Number(scored) : undefined,
            best: Number(best),
            // The contract scales by 100 so it can do the Bayesian arithmetic in integers.
            overall: Number(overallX100) / 100,
            rank: Number(rank),
        };
    }

    return {
        async track(agent, evaluatorId) {
            try {
                return await readOne(agent, categoryOf(evaluatorId));
            } catch {
                // Reputation is decoration on a chat screen, never a reason to break it.
                return emptyTrack(agent);
            }
        },

        async count(evaluatorId) {
            try {
                return Number(
                    await client.readContract({
                        address: passport,
                        abi: passportAbi,
                        functionName: 'agentCountIn',
                        args: [categoryOf(evaluatorId)],
                    }),
                );
            } catch {
                return 0;
            }
        },

        async leaderboard(evaluatorId, offset = 0, limit = DEFAULT_PAGE) {
            const category = categoryOf(evaluatorId);
            try {
                const agents = await client.readContract({
                    address: passport,
                    abi: passportAbi,
                    functionName: 'agentsIn',
                    args: [category, BigInt(offset), BigInt(Math.max(0, limit))],
                });
                const rows = await Promise.all(agents.map((a) => readOne(a, category)));
                // Sort by the Bayesian overall, exactly as the contract's own `rank` does, so the
                // printed order and the printed rank number can never disagree.
                return [...rows].sort((a, b) => b.overall - a.overall);
            } catch {
                return [];
            }
        },
    };
}
