/**
 * config.ts — the whole environment contract, in one place.
 *
 * Two rules, both learned from the Sui version:
 *
 *   1. **Report everything missing at once.** `loadConfig()` there threw on the FIRST absent
 *      variable, so an operator with five unset pointers found out about one per restart. This
 *      returns the complete list.
 *   2. **Every variable this package reads appears here.** Six did not last time — `INDEXER_DB_PATH`
 *      was read independently in the server and the indexer with the default string duplicated in
 *      both, so the two processes could disagree about which database they were using.
 *
 * Addresses come from `contracts/deployments/<chainId>.json` when it is reachable, so a redeploy
 * needs no config change. An explicit environment variable always wins over the file.
 */

import { loadDeployment, type Deployment } from 'quadra-core/deployments';
import { DEFAULT_LOG_CHUNK } from 'quadra-core';
import { COSTON2_DA_URL } from 'quadra-core/ground-truth';
import type { Address } from 'viem';

export interface DataConfig {
    // --- chain -----------------------------------------------------------------------------------
    readonly rpcUrl: string;
    readonly chainId: number;
    /** The deploy block. Without it a cold index walks from genesis and never finishes. */
    readonly fromBlock: bigint;
    readonly jobEscrow: Address;
    readonly sealedCompetition: Address;
    readonly passport: Address;
    readonly teeRegistry: Address;
    readonly quadraToken: Address | undefined;

    // --- indexing --------------------------------------------------------------------------------
    readonly indexerDbPath: string;
    /** How often the tailer asks for a new head. Sets index staleness; Coston2 blocks are ~2s. */
    readonly pollMs: number;
    /** How far behind the head the persisted cursor stays, to absorb a reorg. */
    readonly confirmations: number;
    /** Blocks per `eth_getLogs` window. The single most important knob on a public RPC. */
    readonly logChunkBlocks: bigint;
    /** Blocks one pass commits at a time, so a long backfill advances the cursor as it goes. */
    readonly passSpanBlocks: bigint;
    /** Beyond this lag the index is considered cold and reads fall back to live. */
    readonly maxLagBlocks: number;

    // --- serving ---------------------------------------------------------------------------------
    readonly port: number;
    readonly corsOrigin: string;
    readonly readCacheTtlMs: number;
    readonly explorer: string;

    // --- oracle ----------------------------------------------------------------------------------
    readonly daBaseUrl: string;
    readonly daApiKey: string | undefined;
}

export type ConfigResult =
    | { readonly ok: true; readonly config: DataConfig; readonly source: ConfigSource }
    | { readonly ok: false; readonly missing: readonly string[] };

export interface ConfigSource {
    /** Whether a deployments file supplied any address, and which chain it was for. */
    readonly deploymentFile: boolean;
    readonly chainId: number;
}

const DEFAULT_RPC = 'https://coston2-api.flare.network/ext/C/rpc';
const DEFAULT_EXPLORER = 'https://coston2-explorer.flare.network';
const DEFAULT_DB_PATH = 'quadra-index.db';

function env(name: string): string {
    return (process.env[name] ?? '').trim();
}

function num(name: string, fallback: number): number {
    const raw = env(name);
    if (raw.length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

/** An address from the environment, else from the deployments file, else undefined. */
function address(name: string, fromFile: string | undefined): Address | undefined {
    const raw = env(name);
    const value = raw.length > 0 ? raw : fromFile;
    return value && value.length > 0 ? (value as Address) : undefined;
}

export function loadConfig(): ConfigResult {
    const chainId = num('CHAIN_ID', 114);
    const deployed: Deployment | undefined = loadDeployment(chainId);

    const jobEscrow = address('JOB_ESCROW', deployed?.jobEscrow);
    const sealedCompetition = address('SEALED_COMPETITION', deployed?.sealedCompetition);
    const passport = address('PASSPORT', deployed?.passport);
    const teeRegistry = address('TEE_REGISTRY', deployed?.teeRegistry);

    // Every address is required: this package indexes all four contracts, and a gateway missing one
    // serves a leaderboard or a job history with a silent hole in it rather than an error.
    const missing = [
        ['JOB_ESCROW', jobEscrow],
        ['SEALED_COMPETITION', sealedCompetition],
        ['PASSPORT', passport],
        ['TEE_REGISTRY', teeRegistry],
    ]
        .filter(([, v]) => v === undefined)
        .map(([n]) => n as string);
    if (missing.length > 0) return { ok: false, missing };

    return {
        ok: true,
        source: { deploymentFile: deployed !== undefined, chainId },
        config: {
            rpcUrl: env('CHAIN_RPC_URL') || DEFAULT_RPC,
            chainId,
            fromBlock: BigInt(env('FROM_BLOCK') || String(deployed?.fromBlock ?? 0)),
            jobEscrow: jobEscrow as Address,
            sealedCompetition: sealedCompetition as Address,
            passport: passport as Address,
            teeRegistry: teeRegistry as Address,
            quadraToken: address('QUADRA_TOKEN', deployed?.quadraToken),

            indexerDbPath: env('INDEXER_DB_PATH') || DEFAULT_DB_PATH,
            pollMs: num('INDEXER_POLL_MS', 4_000),
            // Coston2 finalizes quickly, but a handful of blocks costs nothing and is the
            // difference between a rollback that rewinds cleanly and one that cannot.
            confirmations: num('CONFIRMATIONS', 5),
            logChunkBlocks: BigInt(env('LOG_CHUNK_BLOCKS') || String(DEFAULT_LOG_CHUNK)),
            passSpanBlocks: BigInt(env('INDEXER_PASS_SPAN_BLOCKS') || '5000'),
            maxLagBlocks: num('MAX_LAG_BLOCKS', 200),

            port: num('PORT', 8787),
            corsOrigin: env('DATA_CORS_ORIGIN') || '*',
            readCacheTtlMs: num('READ_CACHE_TTL_MS', 30_000),
            explorer: env('EXPLORER_URL') || DEFAULT_EXPLORER,

            daBaseUrl: env('DA_URL') || COSTON2_DA_URL,
            daApiKey: env('DA_API_KEY') || undefined,
        },
    };
}

/** A human-readable explanation of a failed load, for a process that is about to exit. */
export function explainMissing(missing: readonly string[], chainId: number): string {
    return [
        `quadra-data: missing ${missing.length} required setting${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        '',
        `Set them in the environment, or run where contracts/deployments/${chainId}.json is`,
        'reachable — the deploy script writes every address there, so a redeploy needs no config',
        'change at all.',
    ].join('\n');
}

export const txUrl = (explorer: string, hash: string): string => `${explorer}/tx/${hash}`;
export const addressUrl = (explorer: string, addr: string): string => `${explorer}/address/${addr}`;
