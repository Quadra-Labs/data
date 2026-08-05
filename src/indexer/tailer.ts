/**
 * tailer.ts — the EVM log tailer.
 *
 * Replaces THREE separate Sui read paths with one: the gRPC checkpoint stream, the JSON-RPC
 * `queryEvents` used for the cold start, and the Walrus document resolve used for scores. Coston2
 * has no push stream, so this polls; everything else follows from that.
 *
 * What it guarantees:
 *
 *   - **No silent gaps.** The Sui tailer capped a backfill at 500 checkpoints, logged
 *     "gap too large; skipping", and then advanced the cursor anyway — so an hour of downtime
 *     permanently lost every event in it with only a console line to show. There is no cap here.
 *     A large gap is slow, not lossy.
 *   - **Reorg tolerance**, which Sui checkpoints never needed. The cursor stays `confirmations`
 *     blocks behind the head, and the cursor block's hash is re-read every pass: if it changed,
 *     the chain reorganised under us and we rewind rather than carry on with orphaned rows.
 *   - **Ordering.** Logs from several contracts in one window are sorted by
 *     `(blockNumber, logIndex)` before dispatch. Log order alone does not guarantee it across
 *     addresses, and applying a release before its payment would create a phantom job.
 *   - **One block timestamp per block.** EVM logs carry no time field at all, which the Sui
 *     events did; without a cache, a window with 30 logs would cost 30 extra RPC calls.
 */

import type { Address, Hex, Log, PublicClient } from 'viem';
import { getLogsChunked } from 'quadra-core';

import { escalate, isExpectedDisconnect, jittered, messageOf, sleep } from './backoff.js';

/** One log, with everything the router needs to apply it idempotently. */
export interface IndexedLog {
    readonly log: Log;
    readonly address: Address;
    readonly blockNumber: number;
    readonly logIndex: number;
    readonly txHash: Hex;
    /** Block timestamp in epoch MILLISECONDS. The chain reports seconds; see `blockTimeMs`. */
    readonly atMs: number;
}

export interface TailerCursor {
    readonly blockNumber: number;
    readonly blockHash: string;
}

export interface TailerCallbacks {
    /** Apply one batch, in order. Throwing aborts the pass WITHOUT advancing the cursor. */
    readonly onLogs: (logs: readonly IndexedLog[]) => Promise<void> | void;
    /** The pass completed; persist this cursor. */
    readonly onProgress: (cursor: TailerCursor) => Promise<void> | void;
    /** A reorg was detected. Roll back above `toBlock`, then indexing resumes from there. */
    readonly onReorg: (toBlock: number) => Promise<void> | void;
    /** A long historical walk is running, so it does not look hung. */
    readonly onScan?: ((scanned: number, block: bigint) => void) | undefined;
    readonly onError?: ((message: string, expected: boolean) => void) | undefined;
}

export interface TailerOptions extends TailerCallbacks {
    readonly client: PublicClient;
    /** The contracts to watch. Every log from these addresses is fetched in one window each. */
    readonly addresses: readonly Address[];
    /** Where to start when there is no cursor — the deploy block. */
    readonly fromBlock: bigint;
    /** Blocks per getLogs window. */
    readonly chunk: bigint;
    /** How far behind the head the cursor stays, to absorb a reorg. */
    readonly confirmations: number;
    /** How long to wait between passes when already caught up. */
    readonly pollMs: number;
    /** The persisted cursor, if any. */
    readonly startCursor?: TailerCursor | undefined;
    /** Look up a cached block timestamp; return undefined to have the tailer fetch it. */
    readonly cachedBlockTs?: ((blockNumber: number) => number | undefined) | undefined;
    /** Record a fetched block timestamp and hash. */
    readonly rememberBlock?: ((blockNumber: number, ts: number, hash: string) => void) | undefined;
}

export interface TailerHandle {
    /** Stop after the current pass. Idempotent. */
    stop(): void;
    /** Resolves when the loop has actually exited. */
    readonly done: Promise<void>;
    /** True while the loop is running. */
    readonly running: boolean;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Run one catch-up pass and return the new cursor, or undefined when there is nothing to do.
 *
 * Exported separately from the loop so the whole ingestion path can be driven deterministically by
 * a test, one pass at a time, with no timers involved.
 */
export async function runPass(opts: TailerOptions): Promise<TailerCursor | undefined> {
    const head = await opts.client.getBlockNumber();
    // Index only what is confirmed. The tip is real but revocable, and a cursor sitting on it
    // would have to be rewound constantly.
    const safeHead = head - BigInt(Math.max(0, opts.confirmations));
    if (safeHead < opts.fromBlock) return undefined;

    const cursor = opts.startCursor;

    // --- reorg check ----------------------------------------------------------------------------
    // Re-read the block the cursor sits on. If its hash changed, the chain reorganised under us
    // and everything indexed at or above it is orphaned. Sui checkpoints are final on arrival, so
    // this whole branch has no Sui ancestor.
    if (cursor && cursor.blockHash.length > 0) {
        const current = await opts.client
            .getBlock({ blockNumber: BigInt(cursor.blockNumber) })
            .catch(() => undefined);
        if (current && current.hash !== cursor.blockHash) {
            // Rewind a whole confirmation window, not one block: the fork may be several deep,
            // and re-indexing a few hundred blocks is cheap next to serving orphaned data.
            const rewindTo = Math.max(
                Number(opts.fromBlock) - 1,
                cursor.blockNumber - Math.max(1, opts.confirmations),
            );
            await opts.onReorg(rewindTo);
            return { blockNumber: rewindTo, blockHash: '' };
        }
    }

    const from = cursor ? BigInt(cursor.blockNumber) + 1n : opts.fromBlock;
    if (from > safeHead) return undefined; // already caught up

    // --- fetch ----------------------------------------------------------------------------------
    const raw = await getLogsChunked<Log>({
        client: opts.client,
        fromBlock: from,
        toBlock: safeHead,
        chunk: opts.chunk,
        ...(opts.onScan ? { onProgress: opts.onScan } : {}),
        fetch: async (lo, hi) => {
            // One request covers every watched contract, rather than one per address per window.
            const logs = await opts.client.getLogs({
                address: [...opts.addresses],
                fromBlock: lo,
                toBlock: hi,
            });
            return logs;
        },
    });

    // --- order ----------------------------------------------------------------------------------
    // Sorting is not decoration. Two contracts emitting in the same block arrive in whatever order
    // the node returns them, and applying `PaymentReleased` before its `JobPaid` would create a
    // job row with no cost, no user and no deadline.
    const ordered = raw
        .filter((l) => l.blockNumber !== null && l.logIndex !== null)
        .sort((a, b) => {
            const bn = Number(a.blockNumber) - Number(b.blockNumber);
            return bn !== 0 ? bn : Number(a.logIndex) - Number(b.logIndex);
        });

    // --- timestamps -----------------------------------------------------------------------------
    const times = await blockTimesMs(opts, ordered);
    const indexed: IndexedLog[] = ordered.map((log) => ({
        log,
        address: log.address,
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        txHash: log.transactionHash ?? '0x',
        atMs: times.get(Number(log.blockNumber)) ?? 0,
    }));

    if (indexed.length > 0) await opts.onLogs(indexed);

    // --- advance --------------------------------------------------------------------------------
    // The cursor carries the hash of the block it stops on, which is what makes the next pass's
    // reorg check possible at all.
    const tip = await opts.client.getBlock({ blockNumber: safeHead }).catch(() => undefined);
    const next: TailerCursor = {
        blockNumber: Number(safeHead),
        blockHash: tip?.hash ?? '',
    };
    if (tip?.hash) opts.rememberBlock?.(Number(safeHead), Number(tip.timestamp) * 1000, tip.hash);
    await opts.onProgress(next);
    return next;
}

/**
 * Resolve a timestamp for every block that produced a log, in MILLISECONDS.
 *
 * One fetch per distinct block, not per log: a busy 30-block window can hold dozens of logs, and
 * without this the timestamp lookups alone would double the request count on an endpoint that is
 * already the bottleneck. Milliseconds because the whole read model is in ms — the chain reports
 * seconds, and mixing the two silently produces a 1970 activity chart.
 */
async function blockTimesMs(
    opts: TailerOptions,
    logs: readonly Log[],
): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const wanted = new Set<number>();
    for (const l of logs) {
        const n = Number(l.blockNumber);
        const cached = opts.cachedBlockTs?.(n);
        if (cached !== undefined && cached > 0) out.set(n, cached);
        else wanted.add(n);
    }
    for (const n of wanted) {
        const block = await opts.client.getBlock({ blockNumber: BigInt(n) }).catch(() => undefined);
        if (!block) continue;
        const ms = Number(block.timestamp) * 1000;
        out.set(n, ms);
        opts.rememberBlock?.(n, ms, block.hash ?? '');
    }
    return out;
}

/**
 * Start the polling loop.
 *
 * The cursor advances only after `onLogs` returns, so a handler that throws leaves the cursor
 * where it was and the same range is retried. Losing work is always preferable to recording that
 * work was done when it was not.
 */
export function startTailer(opts: TailerOptions): TailerHandle {
    let stopped = false;
    let cursor = opts.startCursor;
    let failures = 0;

    const done = (async () => {
        while (!stopped) {
            try {
                const next = await runPass({ ...opts, startCursor: cursor });
                if (next) cursor = next;
                failures = 0;
                // Caught up: wait a poll interval. Behind: go straight round again, because the
                // pass stopped at the confirmed head and there may be much more history to walk.
                await sleep(next === undefined ? opts.pollMs : 0);
            } catch (err) {
                failures += 1;
                const message = messageOf(err);
                const expected = isExpectedDisconnect(message);
                opts.onError?.(message, expected);
                await sleep(jittered(escalate(opts.pollMs, failures, MAX_BACKOFF_MS)));
            }
        }
    })();

    return {
        stop: () => {
            stopped = true;
        },
        done,
        get running() {
            return !stopped;
        },
    };
}
