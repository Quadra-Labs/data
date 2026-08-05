/**
 * logs.ts — paginated eth_getLogs.
 *
 * Coston2's public RPC caps a single `getLogs` range at 30 blocks, so any "fromBlock -> latest"
 * query fails outright once the chain has moved on. This scans NEWEST -> OLDEST in bounded
 * windows, which also means the common case ("find the delivery that just happened") returns
 * after one request instead of walking the whole history.
 *
 * It lives in the core because five processes need it — the agent runtime, the TEE keeper, the
 * intake engine, this repo's indexer and the verifier — and the window arithmetic is subtle: the
 * public RPC's cap is INCLUSIVE, so an off-by-one makes every request 400, and a 429 mid-scan
 * must back off rather than abandon the walk. Divergent copies are how those bugs come back; the
 * Sui repos already had three copies of a related retry helper and one of them had drifted.
 */

import type { PublicClient } from 'viem';

/** Coston2's public RPC limit. Override via LOG_CHUNK_BLOCKS for a node with a larger cap. */
export const DEFAULT_LOG_CHUNK = 30n;

export function logChunkSize(): bigint {
    const raw = (process.env['LOG_CHUNK_BLOCKS'] ?? '').trim();
    const n = raw.length > 0 ? BigInt(raw) : DEFAULT_LOG_CHUNK;
    return n > 0n ? n : DEFAULT_LOG_CHUNK;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Throttling and blips are expected on a shared public endpoint, and a historical scan is
 * thousands of windows — one 429 must not abort the whole walk. Only transient failures retry; a
 * malformed request still fails immediately, because retrying it just wastes the budget.
 */
export function isTransient(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
        msg.includes('429') ||
        msg.includes('too many requests') ||
        msg.includes('rate limit') ||
        msg.includes('timeout') ||
        msg.includes('econnreset') ||
        msg.includes('econnrefused') ||
        msg.includes('socket hang up') ||
        msg.includes('fetch failed') ||
        msg.includes('503')
    );
}

export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
    for (let i = 0; ; i += 1) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts - 1 || !isTransient(err)) throw err;
            await sleep(300 * 2 ** i); // 300ms, 600, 1.2s, 2.4s, 4.8s
        }
    }
}

export interface ChunkedLogsArgs<T> {
    readonly client: PublicClient;
    readonly fromBlock: bigint;
    readonly toBlock?: bigint;
    readonly chunk?: bigint;
    /** Fetch one bounded window. */
    readonly fetch: (from: bigint, to: bigint) => Promise<readonly T[]>;
    /** Stop at the first non-empty window (newest-first). Use for "the most recent X". */
    readonly stopAtFirstHit?: boolean;
    /** Backoff retries per window on a transient RPC failure. */
    readonly attempts?: number;
    /** Called after each window so a long historical scan shows progress instead of looking hung. */
    readonly onProgress?: (scanned: number, block: bigint) => void;
}

/**
 * Scan a block range in windows small enough for a public RPC, newest first. Results come back
 * oldest-first so callers can keep using `.at(-1)` for "the latest one".
 *
 * Newest-first is right for the live case, but verifying an OLD settlement walks the whole gap
 * back to it — bound that with `toBlock` (which is what verify's --tx hint is for) rather than
 * letting it grind through thousands of windows and get rate-limited.
 */
export async function getLogsChunked<T>(args: ChunkedLogsArgs<T>): Promise<T[]> {
    const chunk = args.chunk ?? logChunkSize();
    const attempts = args.attempts ?? 5;
    const latest = args.toBlock ?? (await withRetry(() => args.client.getBlockNumber(), attempts));
    const found: T[][] = [];

    let hi = latest;
    let scanned = 0;
    while (hi >= args.fromBlock) {
        const lo = hi - chunk + 1n > args.fromBlock ? hi - chunk + 1n : args.fromBlock;
        const batch = await withRetry(() => args.fetch(lo, hi), attempts);
        scanned += 1;
        args.onProgress?.(scanned, lo);
        if (batch.length > 0) {
            found.unshift([...batch]);
            if (args.stopAtFirstHit) break;
        }
        if (lo === args.fromBlock) break;
        hi = lo - 1n;
    }
    return found.flat();
}
