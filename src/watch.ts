import { SuiGrpcClient, GrpcWebFetchTransport } from '@mysten/sui/grpc';
import { Agent } from 'undici';
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

type CheckpointData = { transactions?: { events?: { events?: unknown[] } }[] };

export interface PointerWatcherOptions {
    network: WalrusNetwork;
    url?: string;
    walrusJsonPackageId: string;
    pointers: PointerIds;
    /** Reconnect backoff in ms after a stream error/end (default 2000). */
    reconnectMs?: number;
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
 * The client runs on its own `undici` dispatcher so Walrus blob writes on the
 * global dispatcher can't recycle the long-lived stream's connection. The cursor
 * is seeded from `getServiceInfo` and gaps across reconnects are backfilled with
 * `getCheckpoint`, so no event is lost even if the stream blips.
 */
export class PointerWatcher {
    #client: SuiGrpcClient;
    #agent: Agent;
    #eventType: string;
    #pointerToDb: Map<string, DbName>;
    #reconnectMs: number;
    #running = false;
    #abort: AbortController | undefined;
    #handlers = new Set<ChangeHandler>();
    #lastCursor: bigint | undefined;

    constructor(options: PointerWatcherOptions) {
        const baseUrl = options.url ?? DEFAULT_GRPC_URL[options.network];
        this.#agent = new Agent({
            connect: { family: 4, timeout: 60_000 },
            keepAliveTimeout: 60_000,
            keepAliveMaxTimeout: 600_000,
        });
        const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, { ...init, dispatcher: this.#agent } as RequestInit)) as typeof fetch;
        const transport = new GrpcWebFetchTransport({ baseUrl, fetch: fetchFn });
        this.#client = new SuiGrpcClient({ network: options.network, transport });
        this.#eventType = `${options.walrusJsonPackageId}::pointer::PointerUpdated`;
        this.#reconnectMs = options.reconnectMs ?? 2000;
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
        void this.#agent.destroy();
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
        while (this.#running) {
            const abort = new AbortController();
            this.#abort = abort;
            try {
                const call = this.#client.subscriptionService.subscribeCheckpoints(
                    { readMask: READ_MASK },
                    { abort: abort.signal },
                );
                for await (const res of call.responses) {
                    if (res.cursor === undefined) continue;
                    if (this.#lastCursor !== undefined && res.cursor > this.#lastCursor + 1n) {
                        await this.#backfill(this.#lastCursor + 1n, res.cursor - 1n, abort);
                    }
                    this.#scan(res.checkpoint as CheckpointData | undefined, Number(res.cursor));
                    this.#lastCursor = res.cursor;
                }
            } catch (error) {
                if (!this.#running) return; // aborted by stop()
                console.error(
                    '[watch] checkpoint stream error:',
                    error instanceof Error ? error.message : error,
                );
            }
            if (this.#running) await new Promise((r) => setTimeout(r, this.#reconnectMs));
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
            const { response } = await this.#client.ledgerService.getCheckpoint(
                {
                    checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: seq },
                    readMask: READ_MASK,
                },
                { abort: abort.signal },
            );
            this.#scan(response.checkpoint as CheckpointData | undefined, Number(seq));
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
