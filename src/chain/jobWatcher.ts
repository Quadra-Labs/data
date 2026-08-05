/**
 * jobWatcher.ts — what happens AFTER the buyer says yes, without holding up the conversation.
 *
 * Commissioning a job starts three things nobody should sit and watch: the agent delivers
 * (seconds), the intake engine releases the escrow, and at the horizon the evaluation engine
 * scores it (minutes, sometimes an hour). Blocking on any of it would make a marketplace where
 * buying one thing stops you doing anything else, and on a long horizon it would look like a hang.
 *
 * Two phases, reported independently because they answer different questions:
 *
 *   delivered  the sealed result is on chain and committed to
 *   scored     the TEE graded it against the FTSO feed — reputation, no money
 *
 * Either can fail without the other mattering, so each has its own callback and none throws.
 *
 * Unlike the console's version this does NOT decrypt. `data` holds no buyer keys and should not:
 * it reports that the ciphertext exists and hands back its commitment, and whoever holds the key
 * opens it. That is also what lets the watcher live here rather than dragging the hire client
 * along with it.
 */

import type { Address, Hex, PublicClient } from 'viem';
import { getLogsChunked } from 'quadra-core';

import { jobEscrowAbi } from './abis.js';

/**
 * How far back to look for the JobScored event once job state reports scored. It was detected
 * within one poll of happening, so a shallow scan is plenty and a deep one would be throttled.
 */
const SCORE_LOOKBACK = 900n;

export interface JobWatchCallbacks {
    /**
     * Nothing has arrived and it is starting to look wrong. Fires ONCE, early. A job whose agent
     * runtime is not running looks exactly like one that is thinking — except it never ends — so
     * say so rather than leaving someone watching a spinner.
     */
    readonly onStalled?: ((secs: number) => void) | undefined;
    /** The agent delivered. The commitment is `keccak(ciphertext)`; the buyer's key opens it. */
    readonly onDelivered?: ((ciphertextHash: Hex) => void) | undefined;
    /** The escrow moved to the agent — it delivered work that fits the template. */
    readonly onReleased?: (() => void) | undefined;
    /** Nothing valid arrived in time; the escrow went back to the buyer. */
    readonly onRefunded?: (() => void) | undefined;
    /** The TEE's grade, at the horizon. Terminal. */
    readonly onScored?: ((score: number, receiptHash: Hex) => void) | undefined;
    /** Anything that stopped the watch. */
    readonly onError?: ((message: string) => void) | undefined;
}

export interface JobWatchOptions extends JobWatchCallbacks {
    readonly client: PublicClient;
    readonly jobEscrow: Address;
    readonly jobId: Hex;
    /** The job's own deadline, in unix seconds. Bounds the delivery phase. */
    readonly deliveryDeadline: number;
    readonly statePollMs?: number | undefined;
    /** Warn if nothing is delivered after this long. A healthy agent answers in seconds. */
    readonly stallWarnMs?: number | undefined;
}

export interface JobWatchHandle {
    /** Stop watching. Idempotent; no callback fires afterwards. */
    cancel(): void;
}

/** The score for a settled job, from a shallow bounded window back from the head. */
async function readScore(
    client: PublicClient,
    jobEscrow: Address,
    jobId: Hex,
): Promise<{ score: number; receiptHash: Hex } | undefined> {
    const head = await client.getBlockNumber();
    const floor = head > SCORE_LOOKBACK ? head - SCORE_LOOKBACK : 0n;
    const logs = await getLogsChunked({
        client,
        fromBlock: floor,
        toBlock: head,
        stopAtFirstHit: true,
        fetch: (from, to) =>
            client.getContractEvents({
                address: jobEscrow,
                abi: jobEscrowAbi,
                eventName: 'JobScored',
                args: { jobId },
                fromBlock: from,
                toBlock: to,
            }),
    });
    const hit = logs.at(-1);
    if (hit?.args.score === undefined) return undefined;
    return { score: Number(hit.args.score), receiptHash: hit.args.receiptHash ?? '0x' };
}

export function watchJob(opts: JobWatchOptions): JobWatchHandle {
    const statePollMs = opts.statePollMs ?? 15_000;
    const stallWarnMs = opts.stallWarnMs ?? 30_000;

    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number): void => {
        if (cancelled) return;
        const t = setTimeout(() => {
            timers.delete(t);
            if (!cancelled) fn();
        }, ms);
        timers.add(t);
    };

    let announcedDelivery = false;
    let announcedRelease = false;

    // Everything is read from job STATE rather than from events: one cheap call answers all three
    // questions, where three event scans on a rate-limited public RPC would not.
    const pollState = async (): Promise<void> => {
        if (cancelled) return;
        try {
            const [, , , , , , delivered, released, scored] = await opts.client.readContract({
                address: opts.jobEscrow,
                abi: jobEscrowAbi,
                functionName: 'jobs',
                args: [opts.jobId],
            });

            if (delivered && !announcedDelivery) {
                announcedDelivery = true;
                const hash = await opts.client.readContract({
                    address: opts.jobEscrow,
                    abi: jobEscrowAbi,
                    functionName: 'deliveredHash',
                    args: [opts.jobId],
                });
                opts.onDelivered?.(hash);
            }

            if (released && !announcedRelease) {
                announcedRelease = true;
                // Released WITHOUT a delivery means the deadline passed and the buyer was
                // refunded. Same flag, opposite news.
                if (delivered) opts.onReleased?.();
                else opts.onRefunded?.();
            }

            if (scored) {
                const result = await readScore(opts.client, opts.jobEscrow, opts.jobId);
                if (cancelled) return;
                if (result) opts.onScored?.(result.score, result.receiptHash);
                else opts.onError?.('the job was scored but the score event could not be read back');
                return; // terminal
            }

            // Past the deadline with nothing delivered, the escrow refunds and no delivery can
            // ever land. Waiting longer only prolongs the silence.
            if (!delivered && Math.floor(Date.now() / 1000) > opts.deliveryDeadline + 60) {
                if (!announcedRelease) {
                    opts.onError?.(
                        'no result was delivered before the deadline; the escrow refunds to the ' +
                            'buyer. Check that the agent runtime is running.',
                    );
                }
                return; // terminal
            }
        } catch {
            // A transient RPC failure must not end the watch — the score can still be minutes away.
        }
        later(() => void pollState(), statePollMs);
    };

    later(() => {
        if (cancelled || announcedDelivery) return;
        opts.onStalled?.(Math.round(stallWarnMs / 1000));
    }, stallWarnMs);

    // A short lead-in still catches the release, which happens within seconds of delivery.
    later(() => void pollState(), 2_000);

    return {
        cancel: () => {
            cancelled = true;
            for (const t of timers) clearTimeout(t);
            timers.clear();
        },
    };
}
