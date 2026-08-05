/**
 * events.ts — the push feed.
 *
 * The Sui deployment ran this as a SEPARATE process, because a long-lived gRPC checkpoint stream
 * could not survive alongside multi-second Walrus blob writes. Both halves of that reason are
 * gone, so the emitter is in-process: the indexer already sees every log, and a subscriber is one
 * function call away rather than one more service.
 *
 * Worth stating plainly: the Sui `GET /watch` had ZERO consumers across all ten repos. This exists
 * so the console and any future UI can stop polling an endpoint that rate-limits them — which is
 * the same reason the index exists.
 */

import type { Hex } from 'viem';

export type IndexedEventKind =
    | 'JobPaid'
    | 'Delivered'
    | 'PaymentReleased'
    | 'JobNotDelivered'
    | 'JobScored'
    | 'Recorded'
    | 'CompetitionCreated'
    | 'Joined'
    | 'Submitted'
    | 'PrizeAwarded'
    | 'Settled'
    | 'Cancelled';

export interface IndexedEvent {
    readonly kind: IndexedEventKind | string;
    readonly jobId?: string | undefined;
    readonly competitionId?: string | undefined;
    readonly agent?: string | undefined;
    readonly blockNumber: number;
    readonly txHash: Hex | string;
    readonly atMs: number;
}

export type Subscriber = (event: IndexedEvent) => void;

export interface EventBus {
    publish(event: IndexedEvent): void;
    subscribe(fn: Subscriber): () => void;
    readonly size: number;
}

export function makeEventBus(): EventBus {
    const subscribers = new Set<Subscriber>();
    return {
        publish(event) {
            for (const fn of subscribers) {
                try {
                    fn(event);
                } catch {
                    // One broken subscriber must not stop the others, and must never propagate
                    // back into the indexer's write path.
                }
            }
        },
        subscribe(fn) {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
        get size() {
            return subscribers.size;
        },
    };
}

/**
 * The headers an SSE stream needs to survive a proxy.
 *
 * `X-Accel-Buffering: no` is the one people forget: behind nginx, without it, events are buffered
 * and the connection looks hung until enough bytes accumulate. The Sui version had neither this
 * nor a heartbeat.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
};

/** How often to send a comment line so idle connections are not reaped as dead. */
export const SSE_HEARTBEAT_MS = 25_000;

export const sseFrame = (event: IndexedEvent): string =>
    `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
