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

    constructor(config: DataLayerConfig, clients: Clients) {
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
        this.jobTemplates = new JobTemplates(wj, pointers.job_templates, epochs);
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
            epochs,
        });
    }

    /** Build a {@link DataLayer} from `process.env` (writer; needs `DATA_SECRET_KEY`). */
    static fromEnv(): DataLayer {
        const config = loadConfig();
        return new DataLayer(config, createClients(config));
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
