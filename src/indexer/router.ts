/**
 * router.ts — turn decoded logs into index rows.
 *
 * One switch, one place. Every event this system emits either has a case here or is deliberately
 * ignored; there is no third state where an event is silently dropped because nobody wrote the
 * branch.
 *
 * Two decisions worth knowing before reading the code:
 *
 *   - **`userPubKey` is never stored.** It rides in `JobPaid` and is public calldata already, so
 *     keeping it would leak nothing new in principle. But persisting it in a queryable server
 *     database makes correlating one buyer's jobs trivial for anyone with read access to the
 *     gateway, and this is a confidential-compute project. A client that needs it reads it back
 *     from the log itself.
 *   - **`JobPaid` carries the buyer.** On Sui the payer arrived in a separate `AccessRecorded`
 *     event and had to be joined in afterwards. Here it is one event, so `setJobUser` and the
 *     two-event join both disappear.
 */

import { decodeEventLog, toEventSelector, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { decodeJobParams, jobAsset } from 'quadra-core';

import { jobEscrowAbi, sealedCompetitionAbi, passportAbi } from '../chain/abis.js';
import { categoryOf } from '../chain/passport.js';
import type { IndexDb } from './db.js';
import type { IndexedLog } from './tailer.js';

export interface RouterTargets {
    readonly jobEscrow: Address;
    readonly sealedCompetition: Address;
    readonly passport: Address;
}

export interface RouteStats {
    applied: number;
    /** Events from a watched contract that this build has no case for. Expected, not an error. */
    ignored: number;
    /** Logs that would not decode at all — the tell that an ABI has drifted from its contract. */
    undecodable: number;
    /**
     * What was applied, in order, for the push feed.
     *
     * Collected here rather than re-derived by the caller: this function has already decoded every
     * log, and asking a subscriber to interpret a raw topic hash would be a worse API than the
     * polling it replaces.
     */
    events: AppliedEvent[];
}

export interface AppliedEvent {
    readonly kind: string;
    readonly jobId?: string | undefined;
    readonly competitionId?: string | undefined;
    readonly agent?: string | undefined;
    readonly blockNumber: number;
    readonly txHash: string;
    readonly atMs: number;
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The topic0 of every event an ABI declares.
 *
 * This is what separates "an event we never declared" from "an event we declared and cannot
 * decode". Only the second is a problem. Without the distinction, the ownership and configuration
 * events these contracts emit at construction — four `OwnershipTransferred` on the live deployment
 * — would report as decode failures and permanently cry ABI drift on a healthy index.
 */
function selectorsOf(abi: Abi): Set<string> {
    const out = new Set<string>();
    for (const item of abi) {
        if (item.type === 'event') out.add(toEventSelector(item as AbiEvent));
    }
    return out;
}

const KNOWN = new WeakMap<Abi, Set<string>>();
function knownSelectors(abi: Abi): Set<string> {
    const cached = KNOWN.get(abi);
    if (cached) return cached;
    const built = selectorsOf(abi);
    KNOWN.set(abi, built);
    return built;
}

/**
 * Apply one batch of logs.
 *
 * Wrapped in a single transaction by the caller: a pass that fails partway must leave nothing
 * behind, because the tailer will retry the identical range.
 */
export function routeLogs(
    db: IndexDb,
    targets: RouterTargets,
    logs: readonly IndexedLog[],
): RouteStats {
    const stats: RouteStats = { applied: 0, ignored: 0, undecodable: 0, events: [] };
    for (const entry of logs) {
        const outcome = routeOne(db, targets, entry, stats.events);
        stats[outcome] += 1;
    }
    return stats;
}

type Outcome = 'applied' | 'ignored' | 'undecodable';

function routeOne(
    db: IndexDb,
    targets: RouterTargets,
    entry: IndexedLog,
    applied: AppliedEvent[],
): Outcome {
    const abi = eq(entry.address, targets.jobEscrow)
        ? jobEscrowAbi
        : eq(entry.address, targets.sealedCompetition)
          ? sealedCompetitionAbi
          : eq(entry.address, targets.passport)
            ? passportAbi
            : undefined;
    if (!abi) return 'ignored';

    // An event this ABI never declared is expected, not a fault: these contracts emit ownership,
    // fee and operator events the read model has no use for, and four of them land in the deploy
    // block alone. Only a DECLARED event that fails to decode means the ABI has drifted.
    const topic0 = entry.log.topics[0];
    if (topic0 === undefined || !knownSelectors(abi as unknown as Abi).has(topic0)) {
        return 'ignored';
    }

    let decoded: { eventName: string; args: Record<string, unknown> };
    try {
        decoded = decodeEventLog({
            abi,
            data: entry.log.data,
            topics: entry.log.topics,
        }) as { eventName: string; args: Record<string, unknown> };
    } catch {
        // Declared but undecodable: the signature changed under us. Counted separately because
        // the alternative symptom is an index that quietly stops recording something.
        return 'undecodable';
    }

    const a = decoded.args;
    const note = (): void => {
        applied.push({
            kind: decoded.eventName,
            jobId: a['jobId'] === undefined ? undefined : String(a['jobId']),
            competitionId:
                a['competitionId'] === undefined ? undefined : String(a['competitionId']),
            agent: a['agent'] === undefined ? undefined : String(a['agent']),
            blockNumber: entry.blockNumber,
            txHash: entry.txHash,
            atMs: entry.atMs,
        });
    };
    switch (decoded.eventName) {
        // --- JobEscrow --------------------------------------------------------------------------
        case 'JobPaid': {
            const evaluatorId = String(a['evaluatorId'] ?? '');
            const params = a['params'] as Hex | undefined;
            const agent = String(a['agent'] ?? '');
            const category = evaluatorId ? categoryOf(evaluatorId) : '';
            db.applyJobPaid({
                jobId: String(a['jobId']),
                user: String(a['user'] ?? ''),
                agent,
                evaluatorId,
                category,
                // Never throws on garbage: a buyer can put arbitrary bytes on chain and an
                // indexer must not stop on one malformed job.
                asset: jobAsset(params) ?? String(decodeJobParams(params)['asset'] ?? ''),
                cost: (a['cost'] as bigint) ?? 0n,
                deliveryDeadline: Number(a['deliveryDeadline'] ?? 0n),
                lifetimeEnd: Number(a['lifetimeEnd'] ?? 0n),
                paidAtMs: entry.atMs,
                blockNumber: entry.blockNumber,
            });
            // First sighting of an agent. Identity stays empty until the catalog fills it in;
            // `created_at` keeps the earliest of the two.
            db.upsertAgentIdentity({ wallet: agent, category, evaluatorId, createdAt: entry.atMs });
            note();
            return 'applied';
        }

        case 'Delivered': {
            db.applyDelivered({
                jobId: String(a['jobId']),
                agent: String(a['agent'] ?? ''),
                ciphertextHash: String(a['ciphertextHash'] ?? ''),
                txHash: entry.txHash,
            });
            note();
            return 'applied';
        }

        case 'PaymentReleased': {
            db.applyReleased({
                jobId: String(a['jobId']),
                agent: String(a['agent'] ?? ''),
                earned: (a['agentAmount'] as bigint) ?? 0n,
                fee: (a['fee'] as bigint) ?? 0n,
                atMs: entry.atMs,
            });
            note();
            return 'applied';
        }

        case 'JobNotDelivered': {
            const jobId = String(a['jobId']);
            const agent = String(a['agent'] ?? '');
            // Read the delivery flag BEFORE applying the refund, so the reason describes what
            // actually happened. `JobNotDelivered` fires for two different stories and its name
            // only fits one of them: nothing arrived, or something arrived and was refunded
            // anyway (rejected by intake, or the buyer waited out the grace). Calling the second
            // one "no result was delivered" tells a buyer the opposite of the truth.
            const delivered = db.getJob(jobId)?.delivered === true;
            db.applyRefunded({ jobId, agent, user: String(a['user'] ?? ''), atMs: entry.atMs });
            db.addFailure({
                jobId,
                agent,
                kind: 'delayed',
                reason: delivered
                    ? 'a result was delivered but the escrow was refunded before it was released'
                    : 'no result was delivered before the deadline',
                source: 'chain',
                at: entry.atMs,
            });
            note();
            return 'applied';
        }

        case 'JobScored': {
            db.applyScored({
                jobId: String(a['jobId']),
                agent: String(a['agent'] ?? ''),
                score: Number(a['score'] ?? 0),
                receiptHash: String(a['receiptHash'] ?? ''),
            });
            note();
            return 'applied';
        }

        case 'PassportRecordFailed': {
            // The settlement succeeded but the reputation write did not. Visible on chain
            // precisely so it is not silent; record it rather than letting a track go quietly
            // short by one.
            db.addFailure({
                jobId: String(a['jobId']),
                agent: String(a['agent'] ?? ''),
                kind: 'failed',
                reason: 'the Passport rejected or reverted on the score write',
                source: 'chain',
                at: entry.atMs,
            });
            note();
            return 'applied';
        }

        // --- Passport ---------------------------------------------------------------------------
        case 'Recorded': {
            const agent = String(a['agent'] ?? '');
            const category = String(a['category'] ?? '');
            // Keyed by (txHash, logIndex) inside applyRecorded, because the fold is additive and
            // a reorg replay would otherwise double it.
            db.applyRecorded({
                txHash: entry.txHash,
                logIndex: entry.logIndex,
                agent,
                category,
                sourceId: String(a['sourceId'] ?? ''),
                score: Number(a['score'] ?? 0),
                blockNumber: entry.blockNumber,
                at: entry.atMs,
            });
            note();
            return 'applied';
        }

        // --- SealedCompetition ------------------------------------------------------------------
        case 'CompetitionCreated': {
            const evaluatorId = String(a['evaluatorId'] ?? '');
            db.applyCompetitionCreated({
                competitionId: String(a['competitionId']),
                evaluatorId,
                category: evaluatorId ? categoryOf(evaluatorId) : '',
                kind: Number(a['kind'] ?? 0),
                stake: (a['stake'] as bigint) ?? 0n,
                seedPrize: (a['seedPrize'] as bigint) ?? 0n,
                threshold: (a['threshold'] as bigint) ?? 0n,
                resolveAt: Number(a['resolveAt'] ?? 0n),
                creator: String(a['creator'] ?? ''),
                createdBlock: entry.blockNumber,
                // Stored as the raw blob the event carried. `'0x'` is the legal empty value and
                // means "no scope declared", which is not the same as a missing field.
                params: String(a['params'] ?? '0x'),
                lifetimeSecs: Number(a['lifetimeSecs'] ?? 0),
            });
            note();
            return 'applied';
        }

        case 'Joined': {
            db.applyJoined({
                competitionId: String(a['competitionId']),
                agent: String(a['agent'] ?? ''),
                stake: (a['stake'] as bigint) ?? 0n,
                blockNumber: entry.blockNumber,
            });
            note();
            return 'applied';
        }

        case 'Submitted': {
            db.applySubmitted({
                competitionId: String(a['competitionId']),
                agent: String(a['agent'] ?? ''),
                ciphertextHash: String(a['ciphertextHash'] ?? ''),
                txHash: entry.txHash,
                blockNumber: entry.blockNumber,
            });
            note();
            return 'applied';
        }

        case 'PrizeAwarded': {
            db.applyPrizeAwarded({
                competitionId: String(a['competitionId']),
                agent: String(a['agent'] ?? ''),
                rank: Number(a['rank'] ?? 0n),
                amount: (a['amount'] as bigint) ?? 0n,
                blockNumber: entry.blockNumber,
            });
            note();
            return 'applied';
        }

        case 'Settled': {
            db.applySettled({
                competitionId: String(a['competitionId']),
                receiptHash: String(a['receiptHash'] ?? ''),
                // The payout LEAVES the pool: the contract sets `prizePool = prize - totalPaid`,
                // and what is left is dust the creator may reclaim.
                totalPaid: (a['totalPaid'] as bigint) ?? 0n,
            });
            note();
            return 'applied';
        }

        case 'Cancelled': {
            db.applyCancelled({
                competitionId: String(a['competitionId']),
                seedReturned: (a['seedReturned'] as bigint) ?? 0n,
            });
            note();
            return 'applied';
        }

        // The remaining three ways the pool shrinks. Missing any of them leaves a finished
        // competition advertising money the contract no longer holds.
        case 'StakeWithdrawn': {
            db.applyStakeWithdrawn({
                competitionId: String(a['competitionId']),
                amount: (a['amount'] as bigint) ?? 0n,
            });
            note();
            return 'applied';
        }

        case 'RemainingWithdrawn': {
            db.applyRemainingWithdrawn({
                competitionId: String(a['competitionId']),
                amount: (a['amount'] as bigint) ?? 0n,
            });
            note();
            return 'applied';
        }

        // Decoded, but nothing in the read model depends on it. Listed rather than defaulted, so
        // adding a case is a deliberate act and an unlisted event still shows up in the count.
        //
        // `PrizeClaimed` is paid out of the winner's `owed` balance, which the pool already gave
        // up at settlement — counting it again would subtract the same money twice.
        // `RecorderSet` is a known gap: a newly authorized market would write scores this indexer
        // is not watching. It is owner-only and would accompany a deployment, so the operator
        // restarts with the new address anyway; see the note in DEPLOYMENT-STATE.md.
        case 'ReceiptPublished':
        case 'RecorderSet':
        case 'PrizeClaimed':
        case 'TeeRegistered':
        case 'FccTeeRegistered':
            return 'ignored';

        default:
            return 'ignored';
    }
}
