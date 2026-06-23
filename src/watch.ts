import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
import type { WalrusNetwork } from 'walrus-json';

import type { DbName } from './types.js';
import type { PointerIds } from './config.js';

export interface PointerChange {
    db: DbName;
    pointerId: string;
    blobId: string;
    version: number;
    updatedAtMs: number;
    checkpoint?: number;
}

export type ChangeHandler = (change: PointerChange) => void;

interface PointerUpdatedEvent {
    pointer_id: string;
    blob_id: string;
    version: string;
    updated_at_ms: string;
}

/** Structural shape of a `google.protobuf.Value` (oneof `kind`). */
interface ProtoValue {
    kind:
        | { oneofKind: 'nullValue' }
        | { oneofKind: 'numberValue'; numberValue: number }
        | { oneofKind: 'stringValue'; stringValue: string }
        | { oneofKind: 'boolValue'; boolValue: boolean }
        | { oneofKind: 'structValue'; structValue: { fields: Record<string, ProtoValue> } }
        | { oneofKind: 'listValue'; listValue: { values: ProtoValue[] } }
        | { oneofKind: undefined };
}

function unwrapValue(value: ProtoValue): unknown {
    const k = value.kind;
    switch (k.oneofKind) {
        case 'nullValue':
            return null;
        case 'numberValue':
            return k.numberValue;
        case 'stringValue':
            return k.stringValue;
        case 'boolValue':
            return k.boolValue;
        case 'listValue':
            return k.listValue.values.map(unwrapValue);
        case 'structValue': {
            const out: Record<string, unknown> = {};
            for (const [key, v] of Object.entries(k.structValue.fields)) out[key] = unwrapValue(v);
            return out;
        }
        default:
            return undefined;
    }
}

const DEFAULT_GRPC_URL: Record<WalrusNetwork, string> = {
    testnet: 'https://fullnode.testnet.sui.io:443',
    mainnet: 'https://fullnode.mainnet.sui.io:443',
};

// Native gRPC wants a bare host:port (no scheme); default to the network fullnode.
function toGrpcHost(network: WalrusNetwork, url?: string): string {
    const raw = url ?? DEFAULT_GRPC_URL[network];
    const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return /:\d+$/.test(host) ? host : `${host}:443`;
}

const READ_MASK = {
    paths: [
        'sequence_number',
        'transactions.events.events.event_type',
        'transactions.events.events.json',
    ],
};

// Cap how many checkpoints we backfill after a long disconnect before jumping to
// the live edge.
const MAX_BACKFILL = 500;

// Per-checkpoint backfill fetch retry (absorbs transient fullnode blips so a single
// 5xx doesn't abort the whole stream and force a full reconnect/re-backfill).
const BACKFILL_ATTEMPTS = 4;
const BACKFILL_BASE_MS = 500;
const BACKFILL_MAX_MS = 4000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Add up to 25% jitter so reconnecting clients don't thunder the fullnode in lockstep. */
function jittered(ms: number): number {
    return ms + Math.random() * ms * 0.25;
}

/**
 * Long-lived gRPC streams against a public fullnode are routinely cut (HTTP/2 RST_STREAM,
 * idle GOAWAY, load-balancer recycling). These are expected and fully recovered by the
 * cursor-backfill reconnect, so they log at warn rather than error to avoid alarm fatigue.
 */
function isExpectedDisconnect(message: string): boolean {
    return /RST_STREAM|Connection dropped|UNAVAILABLE|stream removed|GOAWAY|ECONNRESET|socket hang up|deadline|cancelled|EOF|Internal server error|read ECONN/i.test(
        message,
    );
}

type CheckpointData = { transactions?: { events?: { events?: unknown[] } }[] };

export interface PointerWatcherOptions {
    network: WalrusNetwork;
    url?: string;
    walrusJsonPackageId: string;
    pointers: PointerIds;
    /** Base reconnect backoff in ms after a stream error/end (default 2000). Escalates
     * exponentially on consecutive failures and resets once the stream is healthy again. */
    reconnectMs?: number;
    /** Ceiling for the escalating reconnect backoff (default 30000). */
    maxReconnectMs?: number;
    /**
     * Resume from this checkpoint: the first stream response backfills everything
     * after it. Defaults to the current checkpoint height (only future changes).
     */
    fromCheckpoint?: number;
}

/**
 * Watches `pointer::PointerUpdated` via the Sui gRPC checkpoint stream
 * (`subscribeCheckpoints`) and reports which database changed.
 *
 * Uses the native gRPC transport (HTTP/2 via `@grpc/grpc-js`, with keepalive)
 * because the fullnode's grpc-web gateway caps long-lived streams at ~30s. The
 * cursor is seeded from `getServiceInfo` and gaps across reconnects are backfilled
 * with `getCheckpoint`, so no event is lost even if the stream blips.
 */
export class PointerWatcher {
    #client: SuiGrpcClient;
    #eventType: string;
    #pointerToDb: Map<string, DbName>;
    #reconnectMs: number;
    #maxReconnectMs: number;
    #running = false;
    #abort: AbortController | undefined;
    #handlers = new Set<ChangeHandler>();
    #lastCursor: bigint | undefined;

    constructor(options: PointerWatcherOptions) {
        this.#client = new SuiGrpcClient({
            network: options.network,
            transport: new GrpcTransport({
                host: toGrpcHost(options.network, options.url),
                channelCredentials: ChannelCredentials.createSsl(),
                clientOptions: {
                    'grpc.keepalive_time_ms': 20_000,
                    'grpc.keepalive_timeout_ms': 10_000,
                    'grpc.keepalive_permit_without_calls': 1,
                },
            }),
        });
        this.#eventType = `${options.walrusJsonPackageId}::pointer::PointerUpdated`;
        this.#reconnectMs = options.reconnectMs ?? 2000;
        this.#maxReconnectMs = options.maxReconnectMs ?? 30_000;
        this.#pointerToDb = new Map(
            (Object.entries(options.pointers) as [DbName, string][]).map(([db, id]) => [id, db]),
        );
        if (options.fromCheckpoint !== undefined) this.#lastCursor = BigInt(options.fromCheckpoint);
    }

    /** Subscribe to changes. Returns an unsubscribe function. */
    on(handler: ChangeHandler): () => void {
        this.#handlers.add(handler);
        return () => this.#handlers.delete(handler);
    }

    /** Begin streaming. Idempotent. */
    start(): void {
        if (this.#running) return;
        this.#running = true;
        void this.#run();
    }

    /** Stop streaming. */
    stop(): void {
        this.#running = false;
        this.#abort?.abort();
        this.#abort = undefined;
    }

    async #run(): Promise<void> {
        // Seed the cursor with the current checkpoint height so the first stream
        // response backfills every checkpoint since start — including writes made
        // before the stream settled.
        if (this.#lastCursor === undefined) {
            try {
                const { response } = await this.#client.ledgerService.getServiceInfo({});
                if (response.checkpointHeight !== undefined) {
                    this.#lastCursor = response.checkpointHeight;
                }
            } catch {
                // Fall back to starting at the live edge.
            }
        }
        // Consecutive failures since the stream was last healthy; drives exponential backoff.
        let failures = 0;
        while (this.#running) {
            const abort = new AbortController();
            this.#abort = abort;
            let healthy = false;
            try {
                const call = this.#client.subscriptionService.subscribeCheckpoints(
                    { readMask: READ_MASK },
                    { abort: abort.signal },
                );
                for await (const res of call.responses) {
                    // A flowing stream is healthy: clear the backoff so a later blip reconnects fast.
                    healthy = true;
                    failures = 0;
                    if (res.cursor === undefined) continue;
                    if (this.#lastCursor !== undefined && res.cursor > this.#lastCursor + 1n) {
                        await this.#backfill(this.#lastCursor + 1n, res.cursor - 1n, abort);
                    }
                    this.#scan(res.checkpoint as CheckpointData | undefined, Number(res.cursor));
                    this.#lastCursor = res.cursor;
                }
            } catch (error) {
                if (!this.#running) return; // aborted by stop()
                failures = healthy ? 1 : failures + 1;
                const delay = jittered(
                    Math.min(this.#maxReconnectMs, this.#reconnectMs * 2 ** (failures - 1)),
                );
                const msg = error instanceof Error ? error.message : String(error);
                const where = `reconnecting in ${Math.round(delay)}ms`;
                // Expected stream resets are routine for long-lived streams and fully recovered by
                // the cursor backfill — log at warn. Anything else is a genuine error.
                if (isExpectedDisconnect(msg)) {
                    console.warn(`[watch] stream reset (${where}): ${msg}`);
                } else {
                    console.error(`[watch] checkpoint stream error (${where}):`, msg);
                }
                await sleep(delay);
                continue;
            }
            // Stream ended without throwing (server closed it cleanly) — reconnect with backoff.
            if (this.#running) {
                failures = healthy ? 1 : failures + 1;
                await sleep(
                    jittered(Math.min(this.#maxReconnectMs, this.#reconnectMs * 2 ** (failures - 1))),
                );
            }
        }
    }

    /** Fetch and process checkpoints [from, to] missed during a disconnect. */
    async #backfill(from: bigint, to: bigint, abort: AbortController): Promise<void> {
        if (to - from + 1n > BigInt(MAX_BACKFILL)) {
            console.error(
                `[watch] gap of ${to - from + 1n} checkpoints too large; skipping backfill`,
            );
            return;
        }
        for (let seq = from; seq <= to && this.#running; seq++) {
            const response = await this.#getCheckpoint(seq, abort);
            this.#scan(response.checkpoint as CheckpointData | undefined, Number(seq));
        }
    }

    /** Fetch one checkpoint, retrying transient fullnode failures with backoff so a single blip
     * mid-backfill doesn't unwind the whole stream. Throws (to trigger a reconnect) only after
     * exhausting attempts or on abort. */
    async #getCheckpoint(
        seq: bigint,
        abort: AbortController,
    ): Promise<{ checkpoint?: unknown }> {
        let delay = BACKFILL_BASE_MS;
        for (let attempt = 1; ; attempt++) {
            try {
                const { response } = await this.#client.ledgerService.getCheckpoint(
                    {
                        checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: seq },
                        readMask: READ_MASK,
                    },
                    { abort: abort.signal },
                );
                return response;
            } catch (error) {
                if (!this.#running || abort.signal.aborted || attempt >= BACKFILL_ATTEMPTS) throw error;
                await sleep(jittered(delay));
                delay = Math.min(delay * 2, BACKFILL_MAX_MS);
            }
        }
    }

    #scan(checkpoint: CheckpointData | undefined, cursor: number): void {
        for (const tx of checkpoint?.transactions ?? []) {
            for (const ev of tx.events?.events ?? []) {
                const event = ev as { eventType?: string; json?: ProtoValue };
                if (event.eventType !== this.#eventType || !event.json) continue;
                this.#emit(unwrapValue(event.json) as PointerUpdatedEvent, cursor);
            }
        }
    }

    #emit(parsed: PointerUpdatedEvent, checkpoint: number): void {
        const db = this.#pointerToDb.get(parsed.pointer_id);
        if (!db) return; // an unrelated pointer
        const change: PointerChange = {
            db,
            pointerId: parsed.pointer_id,
            blobId: parsed.blob_id,
            version: Number(parsed.version),
            updatedAtMs: Number(parsed.updated_at_ms),
            checkpoint,
        };
        for (const handler of this.#handlers) handler(change);
    }
}
