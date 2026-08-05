/**
 * backoff.ts — reconnect discipline, salvaged from the Sui watcher.
 *
 * The Sui repo had TWO stream tailers that had drifted apart: `watch.ts` grew exponential backoff,
 * jitter and log-level classification, while `indexer/tailer.ts` kept a flat retry and none of it.
 * Only one of them is worth carrying forward, so this is the good half, extracted.
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Up to 25% jitter, so several processes recovering from the same outage do not reconnect in
 * lockstep and knock the endpoint over again the instant it comes back.
 */
export function jittered(ms: number): number {
    return ms + Math.random() * ms * 0.25;
}

/** Exponential escalation, capped. */
export function escalate(base: number, failures: number, max: number): number {
    return Math.min(max, base * 2 ** Math.max(0, failures - 1));
}

/**
 * Failures a shared public endpoint produces as a matter of course: rate limits, load-balancer
 * recycling, idle resets. They are fully recovered by the next poll, so they log at warn rather
 * than error — alarm fatigue is what makes a real outage invisible.
 */
export function isExpectedDisconnect(message: string): boolean {
    return /429|too many requests|rate limit|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|timeout|fetch failed|502|503|504|EAI_AGAIN|network error/i.test(
        message,
    );
}

export const messageOf = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
