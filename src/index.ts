import {
    createClients,
    createReadClients,
    loadConfig,
    type Clients,
    type DataLayerConfig,
    type PointerIds,
} from './config.js';
import { AgentScores } from './dbs/agentScores.js';
import { AgentEndpoints } from './dbs/agentEndpoints.js';
import { OnchainAgents } from './agentRegistry.js';
import { DelayedFailedJobs } from './dbs/delayedFailedJobs.js';
import { JobTemplates } from './dbs/jobTemplates.js';
import { JobScheduler } from './dbs/jobScheduler.js';
import { JobResultsIndex } from './dbs/jobResultsIndex.js';
import { EvalEngines } from './dbs/evalEngines.js';
import { JobResults } from './seal.js';
import { PointerWatcher } from './watch.js';
import { OffchainStore } from './offchain/store.js';
import { FlushWorker } from './offchain/flushWorker.js';
import { KeyedLock } from './offchain/keyedLock.js';

/** The write-behind collaborators the gateway injects so writes return before the on-chain flush. */
export interface WriteBehind {
    store: OffchainStore;
    worker: FlushWorker;
    lock: KeyedLock;
}

/**
 * The Quadra data layer: one handle to every database, sharing a single Walrus +
 * Sui + Seal client set. Build it with {@link DataLayer.fromEnv} (reads the
 * environment) or pass an explicit config and clients.
 */
export class DataLayer {
    readonly config: DataLayerConfig;
    readonly clients: Clients;

    readonly agentScores: AgentScores;
    /** Where live agents can be reached. Undefined until the pointer is bootstrapped. */
    readonly agentEndpoints?: AgentEndpoints;
    /** Agent identity — read from the on-chain `agent::AgentRegistry`. */
    readonly agents: OnchainAgents;
    readonly delayedFailedJobs: DelayedFailedJobs;
    readonly jobTemplates: JobTemplates;
    readonly jobScheduler: JobScheduler;
    readonly jobResultsIndex: JobResultsIndex;
    readonly evalEngines: EvalEngines;
    readonly jobResults: JobResults;
    /** Present when write-behind is on: the durable store + background flush worker. */
    readonly writeBehind?: WriteBehind;

    constructor(config: DataLayerConfig, clients: Clients, writeBehind?: WriteBehind) {
        this.config = config;
        this.clients = clients;

        const { wj } = clients;
        const { epochs, pointers } = config;
        this.agentScores = new AgentScores(wj, pointers.agent_scores, epochs);
        if (pointers.agent_endpoints) {
            this.agentEndpoints = new AgentEndpoints(wj, pointers.agent_endpoints, epochs);
        }
        this.agents = new OnchainAgents({
            network: config.network,
            ...(process.env.DATA_BASE_URL ? { url: process.env.DATA_BASE_URL } : {}),
            registryId: config.agentRegistryId,
        });
        this.delayedFailedJobs = new DelayedFailedJobs(wj, pointers.delayed_failed_jobs, epochs);
        this.jobTemplates = new JobTemplates(
            wj,
            pointers.job_templates,
            epochs,
            config.templatesCacheTtlMs,
        );
        this.jobScheduler = new JobScheduler(wj, pointers.job_scheduler, epochs);
        this.jobResultsIndex = new JobResultsIndex(wj, pointers.job_results_index, epochs);
        this.evalEngines = new EvalEngines(wj, pointers.eval_engines, epochs);
        this.jobResults = new JobResults({
            wj,
            seal: clients.seal,
            sui: clients.sui,
            index: this.jobResultsIndex,
            quadraPackageId: config.quadraPackageId,
            jobAccessRegistryId: config.jobAccessRegistryId,
            threshold: config.sealThreshold,
            // Result blobs persist far longer than pointer docs (RESULT_EPOCHS, default 30) so
            // buyers can still reveal a result weeks after delivery — not the 5-epoch pointer TTL.
            epochs: config.resultEpochs,
        });

        // Serve every pointer-backed READ from an in-memory stale-while-revalidate cache so a slow
        // Walrus resolve (~10s) never lands on a request. Writes go THROUGH this gateway and
        // PointerDoc is write-through, so the gateway's own writes stay instantly consistent;
        // cross-process writes (e.g. seed scripts) converge within the TTL. jobTemplates keeps its
        // dedicated TEMPLATES_CACHE_TTL_MS (set in its constructor); enable the rest here.
        const readTtl = config.readCacheTtlMs;
        this.evalEngines.enableCache(readTtl);
        this.agentScores.enableCache(readTtl);
        this.jobScheduler.enableCache(readTtl);
        this.jobResultsIndex.enableCache(readTtl);
        this.delayedFailedJobs.enableCache(readTtl);
        this.agentEndpoints?.enableCache(readTtl);

        // Write-behind: route every write through the durable off-chain store + background flush
        // worker so the request path never waits on a Walrus/Sui commit. Injected only by the
        // gateway (fromEnv); read-only layers (forReads) and tests keep synchronous writes.
        if (writeBehind) {
            this.writeBehind = writeBehind;
            const docs = [
                this.agentScores,
                this.delayedFailedJobs,
                this.jobTemplates,
                this.jobScheduler,
                this.jobResultsIndex,
                this.evalEngines,
                ...(this.agentEndpoints ? [this.agentEndpoints] : []),
            ];
            for (const doc of docs) doc.enableWriteBehind(writeBehind);
            this.jobResults.enableWriteBehind(writeBehind.store, writeBehind.worker);
        }
    }

    /**
     * Resolve every cached read doc once, in parallel, so the first real request for ANY of them is
     * served from memory instead of paying the cold Walrus resolve. Call it on gateway boot. Best
     * effort: a doc that fails to warm just resolves lazily on its first read. NEVER throws.
     */
    async warmCaches(): Promise<{ db: string; ok: boolean }[]> {
        const docs: [string, { prime(): Promise<unknown> }][] = [
            ['job_templates', this.jobTemplates],
            ['eval_engines', this.evalEngines],
            ['agent_scores', this.agentScores],
            ['job_scheduler', this.jobScheduler],
            ['job_results_index', this.jobResultsIndex],
            ['delayed_failed_jobs', this.delayedFailedJobs],
            ...(this.agentEndpoints
                ? ([['agent_endpoints', this.agentEndpoints]] as [string, { prime(): Promise<unknown> }][])
                : []),
        ];
        return Promise.all(
            docs.map(async ([db, doc]) => {
                try {
                    await doc.prime();
                    return { db, ok: true };
                } catch {
                    return { db, ok: false };
                }
            }),
        );
    }

    /**
     * Build a {@link DataLayer} from `process.env` (writer; needs `DATA_SECRET_KEY`). Writes are
     * write-behind by default — durable in the off-chain store immediately, flushed on-chain by a
     * background worker. Set `WRITE_BEHIND=0` to fall back to fully synchronous on-chain writes.
     */
    static fromEnv(): DataLayer {
        const config = loadConfig();
        const clients = createClients(config);
        if (process.env.WRITE_BEHIND === '0') return new DataLayer(config, clients);
        const store = new OffchainStore(config.offchainDbPath);
        const worker = new FlushWorker(store, { sweepMs: config.writeBehindSweepMs });
        return new DataLayer(config, clients, { store, worker, lock: new KeyedLock() });
    }

    /**
     * Build a read-only {@link DataLayer} from `process.env` (ephemeral signer, no
     * `DATA_SECRET_KEY`). For engines that read + Seal-decrypt but write through
     * the gateway. Calling a write method will fail (the key owns no pointers).
     */
    static forReads(): DataLayer {
        const config = loadConfig();
        return new DataLayer(config, createReadClients(config));
    }

    /** A watcher for `PointerUpdated` events across all public databases. */
    createWatcher(overrides: { fromCheckpoint?: number } = {}): PointerWatcher {
        return new PointerWatcher({
            network: this.config.network,
            ...(this.config.grpcUrl ? { url: this.config.grpcUrl } : {}),
            walrusJsonPackageId: this.config.walrusJsonPackageId,
            pointers: this.config.pointers,
            reconnectMs: this.config.watchReconnectMs,
            ...overrides,
        });
    }
}

export { createClients, createReadClients, loadConfig };
export { loadGatewayAuth } from './config.js';
export type { Clients, DataLayerConfig, PointerIds };
export type { Role, GatewayAuth } from './config.js';

export { GatewayClient } from './gateway.js';
export type { GatewayClientOptions } from './gateway.js';

export {
    EvalEngineRegistry,
    createEvalEngineRegistry,
    loadEvalEnginesFromEnv,
} from './evalEngineRegistry.js';
export type { ResolvedEvalEngine, EvalEngineLookup } from './evalEngineRegistry.js';

export { AgentScores } from './dbs/agentScores.js';
export { AgentEndpoints, EMPTY_AGENT_ENDPOINTS } from './dbs/agentEndpoints.js';
export { OnchainAgents } from './agentRegistry.js';
export type { AgentInfo, OnchainAgentsOptions } from './agentRegistry.js';
export { DelayedFailedJobs } from './dbs/delayedFailedJobs.js';
export { JobTemplates } from './dbs/jobTemplates.js';
export { JobScheduler, type ScheduledJob } from './dbs/jobScheduler.js';
export { JobResultsIndex } from './dbs/jobResultsIndex.js';
export { EvalEngines, EMPTY_EVAL_ENGINES } from './dbs/evalEngines.js';
export { PointerDoc } from './dbs/base.js';
export { JobResults, type JobResultsOptions, type ResultReader } from './seal.js';
// Re-export `Transaction` so a consumer that builds a tx for this package's exposed
// `clients.sui` uses the SAME physical `@mysten/sui` copy as the data layer — avoiding the
// duplicate-identity clash a `file:`-linked consumer hits if it imports `Transaction` from its
// own `@mysten/sui`.
export { Transaction } from '@mysten/sui/transactions';
export { PointerWatcher } from './watch.js';
export type { PointerChange, ChangeHandler, PointerWatcherOptions } from './watch.js';

export * from './types.js';
