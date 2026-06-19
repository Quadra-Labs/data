/**
 * Generic checkpoint tailer: subscribes to the Sui gRPC checkpoint stream and
 * emits every event whose type is in a watch set, plus a per-checkpoint heartbeat
 * so the caller can persist a resume cursor.
 *
 * Uses the NATIVE gRPC transport (@grpc/grpc-js, HTTP/2) rather than grpc-web over
 * fetch: the fullnode's grpc-web gateway caps long-lived streams at ~30s, while the
 * native HTTP/2 stream (with keepalive) runs indefinitely. Reconnect + gap backfill
 * remain as the documented resilience pattern for any blips.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
import type { WalrusNetwork } from 'walrus-json';

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

const READ_MASK = {
    paths: [
        'sequence_number',
        'transactions.events.events.event_type',
        'transactions.events.events.json',
    ],
};

const MAX_BACKFILL = 500;

type CheckpointData = { transactions?: { events?: { events?: unknown[] } }[] };

// Native gRPC wants a bare host:port (no scheme); default to the network fullnode.
function toGrpcHost(network: WalrusNetwork, url?: string): string {
    const raw = url ?? `fullnode.${network}.sui.io:443`;
    const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return /:\d+$/.test(host) ? host : `${host}:443`;
}

export interface TailedEvent {
    eventType: string;
    json: Record<string, unknown>;
    checkpoint: number;
}

export interface CheckpointTailerOptions {
    network: WalrusNetwork;
    /** Override the gRPC host (scheme optional). Defaults to the network fullnode. */
    url?: string;
    /** Fully-qualified event types to emit (e.g. `${pkg}::intake::JobPaid`). */
    eventTypes: Iterable<string>;
    onEvent: (event: TailedEvent) => void;
    /** Called once per processed checkpoint (live + backfilled) with its sequence. */
    onCheckpoint?: (sequence: number) => void;
    reconnectMs?: number;
    /** Resume from this checkpoint; the first response backfills everything after it. */
    fromCheckpoint?: number;
}

export class CheckpointTailer {
    #client: SuiGrpcClient;
    #host: string;
    #types: Set<string>;
    #onEvent: (event: TailedEvent) => void;
    #onCheckpoint: ((sequence: number) => void) | undefined;
    #reconnectMs: number;
    #running = false;
    #abort: AbortController | undefined;
    #lastCursor: bigint | undefined;

    constructor(options: CheckpointTailerOptions) {
        this.#host = toGrpcHost(options.network, options.url);
        this.#client = new SuiGrpcClient({
            network: options.network,
            transport: new GrpcTransport({
                host: this.#host,
                channelCredentials: ChannelCredentials.createSsl(),
                // Keepalive PINGs keep the HTTP/2 connection healthy on idle gaps.
                clientOptions: {
                    'grpc.keepalive_time_ms': 20_000,
                    'grpc.keepalive_timeout_ms': 10_000,
                    'grpc.keepalive_permit_without_calls': 1,
                },
            }),
        });
        this.#types = new Set(options.eventTypes);
        this.#onEvent = options.onEvent;
        this.#onCheckpoint = options.onCheckpoint;
        this.#reconnectMs = options.reconnectMs ?? 2000;
        if (options.fromCheckpoint !== undefined) this.#lastCursor = BigInt(options.fromCheckpoint);
    }

    get host(): string {
        return this.#host;
    }

    start(): void {
        if (this.#running) return;
        this.#running = true;
        void this.#run();
    }

    stop(): void {
        this.#running = false;
        this.#abort?.abort();
        this.#abort = undefined;
    }

    async #run(): Promise<void> {
        if (this.#lastCursor === undefined) {
            try {
                const { response } = await this.#client.ledgerService.getServiceInfo({});
                if (response.checkpointHeight !== undefined) this.#lastCursor = response.checkpointHeight;
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
                if (!this.#running) return;
                console.error(
                    '[indexer] checkpoint stream error (will reconnect):',
                    error instanceof Error ? error.message : error,
                );
            }
            if (this.#running) await new Promise((r) => setTimeout(r, this.#reconnectMs));
        }
    }

    async #backfill(from: bigint, to: bigint, abort: AbortController): Promise<void> {
        if (to - from + 1n > BigInt(MAX_BACKFILL)) {
            console.error(`[indexer] gap of ${to - from + 1n} checkpoints too large; skipping backfill`);
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

    #scan(checkpoint: CheckpointData | undefined, sequence: number): void {
        for (const tx of checkpoint?.transactions ?? []) {
            for (const ev of tx.events?.events ?? []) {
                const event = ev as { eventType?: string; json?: ProtoValue };
                if (!event.eventType || !this.#types.has(event.eventType) || !event.json) continue;
                this.#onEvent({
                    eventType: event.eventType,
                    json: (unwrapValue(event.json) as Record<string, unknown>) ?? {},
                    checkpoint: sequence,
                });
            }
        }
        this.#onCheckpoint?.(sequence);
    }
}
