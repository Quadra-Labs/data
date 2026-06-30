import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SealClient, type KeyServerConfig, type SealCompatibleClient } from '@mysten/seal';
import { WalrusJsonClient, type WalrusNetwork } from 'walrus-json';

/** On-chain pointer object ids, one per Walrus-backed database. */
export interface PointerIds {
    agent_scores: string;
    delayed_failed_jobs: string;
    job_templates: string;
    job_scheduler: string;
    job_results_index: string;
    eval_engines: string;
    /** Optional: present once `bootstrap` has created the agent-endpoints pointer.
     * Absent on older deploys — the agent-endpoints store is then unavailable. */
    agent_endpoints?: string;
}

/** Everything the data layer needs, resolved from the environment. */
export interface DataLayerConfig {
    network: WalrusNetwork;
    epochs: number;
    /**
     * Epochs to store sealed job RESULT blobs for. Kept much longer than `epochs` (pointer docs)
     * so a buyer can still reveal a result long after delivery — at 5 epochs results vanished in
     * ~5 days and `/job-results` then 410s. Walrus is pay-per-epoch (no permanent tier; ~53 max).
     */
    resultEpochs: number;
    walrusJsonPackageId: string;
    quadraPackageId: string;
    jobAccessRegistryId: string;
    /** Shared `agent::AgentRegistry` object id (agents are read on-chain). */
    agentRegistryId: string;
    sealKeyServerIds: string[];
    sealThreshold: number;
    /** gRPC(-web) endpoint for the checkpoint-stream watcher (optional override). */
    grpcUrl?: string;
    /** Reconnect backoff (ms) for the watcher stream. */
    watchReconnectMs: number;
    /** Port for the REST writer service. */
    port: number;
    /** Port for the separate watch (gRPC stream + SSE) service. */
    watchPort: number;
    /** Stale-while-revalidate TTL (ms) for GET /templates. 0 disables the cache. */
    templatesCacheTtlMs: number;
    /** Stale-while-revalidate TTL (ms) for every OTHER read-served pointer doc (eval-engines,
     *  scores, scheduler, results index, endpoints, delayed-failed). 0 disables their cache. */
    readCacheTtlMs: number;
    /** SQLite file backing the write-behind store (relative to the gateway's working dir). */
    offchainDbPath: string;
    /** Periodic retry/recovery cadence (ms) for the background on-chain flush worker. */
    writeBehindSweepMs: number;
    pointers: PointerIds;
}

/** Live clients shared across the data layer. */
export interface Clients {
    signer: Ed25519Keypair;
    wj: WalrusJsonClient;
    seal: SealClient;
    sui: SealCompatibleClient;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

function optionalNumber(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${value}"`);
    return n;
}

function csv(name: string): string[] {
    return required(name)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** Build the full config from `process.env`. Pointer ids come from `bootstrap`. */
export function loadConfig(): DataLayerConfig {
    const network = (process.env.DATA_NETWORK ?? 'testnet') as WalrusNetwork;
    return {
        network,
        epochs: optionalNumber('DATA_EPOCHS', 5),
        resultEpochs: optionalNumber('RESULT_EPOCHS', 30),
        walrusJsonPackageId: required('WALRUS_JSON_PACKAGE_ID'),
        quadraPackageId: required('QUADRA_PACKAGE_ID'),
        jobAccessRegistryId: required('JOB_ACCESS_REGISTRY_ID'),
        agentRegistryId: required('AGENT_REGISTRY_ID'),
        sealKeyServerIds: csv('SEAL_KEY_SERVER_IDS'),
        sealThreshold: optionalNumber('SEAL_THRESHOLD', 1),
        ...(process.env.DATA_GRPC_URL ? { grpcUrl: process.env.DATA_GRPC_URL } : {}),
        watchReconnectMs: optionalNumber('WATCH_RECONNECT_MS', 2000),
        port: optionalNumber('PORT', 8787),
        watchPort: optionalNumber('WATCH_PORT', 8788),
        templatesCacheTtlMs: optionalNumber('TEMPLATES_CACHE_TTL_MS', 30_000),
        readCacheTtlMs: optionalNumber('DATA_READ_CACHE_TTL_MS', 30_000),
        offchainDbPath: process.env.OFFCHAIN_DB_PATH ?? 'quadra-writeback.db',
        writeBehindSweepMs: optionalNumber('WRITE_BEHIND_SWEEP_MS', 5_000),
        pointers: {
            agent_scores: required('POINTER_AGENT_SCORES'),
            delayed_failed_jobs: required('POINTER_DELAYED_FAILED'),
            job_templates: required('POINTER_JOB_TEMPLATES'),
            job_scheduler: required('POINTER_JOB_SCHEDULER'),
            job_results_index: required('POINTER_JOB_RESULTS_INDEX'),
            eval_engines: required('POINTER_EVAL_ENGINES'),
            ...(process.env.POINTER_AGENT_ENDPOINTS
                ? { agent_endpoints: process.env.POINTER_AGENT_ENDPOINTS }
                : {}),
        },
    };
}

/** Build the shared clients with `signer`. Seal reuses the Sui connection. */
function buildClients(config: DataLayerConfig, signer: Ed25519Keypair): Clients {
    // Upload through the Walrus UPLOAD RELAY (a few seconds) instead of uploading directly to
    // every storage node (tens of seconds, hang-prone on testnet). Defaults to Mysten's testnet
    // relay; override the host with WALRUS_UPLOAD_RELAY_HOST (set it for mainnet). The relay
    // charges a small WAL tip per blob (testnet advertises a const ~105 FROST); sendTip.max caps
    // it. Set WALRUS_UPLOAD_RELAY_HOST="" to fall back to direct uploads.
    const relayEnv = process.env.WALRUS_UPLOAD_RELAY_HOST;
    const relayHost =
        relayEnv !== undefined
            ? relayEnv.trim()
            : config.network === 'testnet'
              ? 'https://upload-relay.testnet.walrus.space'
              : '';
    const relayMaxTip = Number(process.env.WALRUS_UPLOAD_RELAY_MAX_TIP ?? 1_000_000);

    const wj = new WalrusJsonClient({
        network: config.network,
        signer,
        packageId: config.walrusJsonPackageId,
        defaultEpochs: config.epochs,
        ...(process.env.DATA_BASE_URL ? { baseUrl: process.env.DATA_BASE_URL } : {}),
        ...(relayHost.length > 0
            ? { walrus: { uploadRelay: { host: relayHost, sendTip: { max: relayMaxTip } } } }
            : {}),
    });

    const sui = wj.sui as unknown as SealCompatibleClient;
    const serverConfigs: KeyServerConfig[] = config.sealKeyServerIds.map((objectId) => ({
        objectId,
        weight: 1,
    }));
    const seal = new SealClient({ suiClient: sui, serverConfigs, verifyKeyServers: false });

    return { signer, wj, seal, sui };
}

/** Build the write clients (the gateway). Requires `DATA_SECRET_KEY`. */
export function createClients(config: DataLayerConfig): Clients {
    return buildClients(config, Ed25519Keypair.fromSecretKey(required('DATA_SECRET_KEY')));
}

/**
 * Build read-only clients with an ephemeral keypair — reads cost nothing and Seal
 * decrypt uses the caller's own key, so engines never need `DATA_SECRET_KEY`.
 */
export function createReadClients(config: DataLayerConfig): Clients {
    return buildClients(config, Ed25519Keypair.generate());
}

/** A first-party engine role that may write certain databases. */
export type Role = 'intake' | 'scheduler' | 'admin';

/** Gateway write-authorization config: role tokens + the agent-signature window. */
export interface GatewayAuth {
    /** token -> role (set via ROLE_TOKEN_INTAKE / _SCHEDULER / _ADMIN). */
    roleTokens: Map<string, Role>;
    agentAuthWindowMs: number;
}

export function loadGatewayAuth(): GatewayAuth {
    const roleTokens = new Map<string, Role>();
    const add = (envVar: string, role: Role) => {
        const token = process.env[envVar];
        if (token) roleTokens.set(token, role);
    };
    add('ROLE_TOKEN_INTAKE', 'intake');
    add('ROLE_TOKEN_SCHEDULER', 'scheduler');
    add('ROLE_TOKEN_ADMIN', 'admin');
    return { roleTokens, agentAuthWindowMs: optionalNumber('AGENT_AUTH_WINDOW_MS', 60_000) };
}
