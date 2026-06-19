/**
 * Record shapes for the Quadra data layer.
 *
 * Each public database is a single JSON document stored on Walrus behind one
 * on-chain `JsonPointer`. Records are keyed by id so updates are cheap dot-path
 * mutations. Job results are the exception: each is its own Seal-encrypted blob,
 * discoverable through the public results index.
 */

/** A job category. Agents belong to exactly one. */
export type Category = 'finance' | 'prediction';

/** Which Quadra database a value belongs to. Used for routing and watch events. */
export type DbName =
    | 'agent_scores'
    | 'delayed_failed_jobs'
    | 'job_templates'
    | 'job_scheduler'
    | 'job_results_index';

// --- agent_scores ----------------------------------------------------------

/** One agent's running performance, recomputed on every delivery. */
export interface AgentScore {
    /** Agent wallet address (the agent id). */
    wallet: string;
    /** Overall score in [0, 100], an equal-weight average of all job scores. */
    score: number;
    /** How many jobs the agent has delivered (the average's denominator). */
    total_jobs_delivered: number;
}

export interface AgentScoresDoc {
    agents: Record<string, AgentScore>;
    updated_at: number;
}

// Agent identity now lives on chain (`agent::AgentRegistry`); see `OnchainAgents`.

// --- delayed_failed_jobs ---------------------------------------------------

/** Why a job ended up in the delayed/failed log. */
export type FailureKind = 'delayed' | 'failed';

/** One entry in the delayed/failed jobs log. */
export interface FailedJob {
    job_id: string;
    /** The agent the job was assigned to, if known. */
    agent: string | null;
    kind: FailureKind;
    /** Human-readable reason (e.g. the evaluation engine's error). */
    reason: string;
    /** When the failure was recorded, epoch ms. */
    at: number;
}

export interface DelayedFailedJobsDoc {
    jobs: FailedJob[];
    updated_at: number;
}

// --- job_templates ---------------------------------------------------------

/**
 * A well-defined job shape. `output` is a field -> type-name schema describing
 * exactly what an agent must return, e.g. `{ minPrice: 'number', maxPrice: 'number' }`.
 */
export interface JobTemplate {
    id: string;
    category: Category;
    description: string;
    output: Record<string, string>;
    /** The evaluation engine's category id (e.g. "price-range-guess"). One enclave
     * serves one evaluator_id; the scheduler maps it to that engine's URL. */
    evaluator_id: string;
    /**
     * Schema for the start data captured at delivery (field -> type-name), e.g.
     * `{ start_price: 'number' }`. The validator asks the eval engine for it and
     * intake records it in the scheduler so it survives until scoring.
     */
    start_data_template: Record<string, string>;
    /** Shortest lifetime this template accepts, in milliseconds (e.g. 60000 = 1 min). */
    minimum_lifetime: number;
    /** Asset symbols a job may target (subset of the supported universe). */
    allowed_assets: string[];
    /** When true, the job is paid on delivery (result stored), never validated/scored — no
     * asset/lifetime/scoring window. Absent/false = a normal scored job. (Friend's intake feature.) */
    scoreless?: boolean;
}

export interface JobTemplatesDoc {
    templates: Record<string, JobTemplate>;
    updated_at: number;
}

// --- job_scheduler ---------------------------------------------------------

/** The asset + start data snapshotted at delivery, kept until the job is scored. */
export interface JobStart {
    asset: string;
    /** Matches the template's `start_data_template` (e.g. `{ start_price: ... }`). */
    data: Record<string, unknown>;
}

/**
 * `job_id -> expiry (epoch ms)` plus a parallel `job_id -> start data` map. The
 * scheduler engine lists `jobs` every epoch, acts on due entries, and reads
 * `start_data` to score against the price captured at delivery.
 */
export interface JobSchedulerDoc {
    jobs: Record<string, number>;
    start_data: Record<string, JobStart>;
    updated_at: number;
}

// --- job_results -----------------------------------------------------------

/** Lifecycle of a job result. */
export type JobStatus = 'pending' | 'delivered' | 'failed';

/** The job a result belongs to: its lifetime plus the template it was built from. */
export interface JobSpec {
    /** e.g. "5m" — how long the job is live. Mandatory. */
    lifetime: string;
    template: JobTemplate;
}

/**
 * The plaintext of a private job result. The whole object is Seal-encrypted and
 * stored as a Walrus blob; only the job's user and agent can decrypt it.
 */
export interface JobResult {
    job_id: string;
    /** The paying user's wallet. */
    user: string;
    /** The agent's wallet. */
    agent: string;
    status: JobStatus;
    job: JobSpec;
    /** The fixed job params the result was produced against (e.g. prediction's
     * `{ market_id, target_ts }`). Forwarded to the evaluation engine at scoring for
     * evaluators that resolve ground truth from params (polymarket-*). Absent for finance
     * jobs, which resolve from `asset`. */
    params?: Record<string, string>;
    /** What the agent returned (shape matches the template `output`). */
    agent_result: Record<string, unknown>;
    /** The deterministic data the evaluation engine produced. */
    finalized_result: Record<string, unknown>;
    /** The evaluation score in [0, 100]. */
    score: number;
    started_at: number;
    delivered_at: number;
}

/** The JSON envelope actually written to Walrus for a sealed result. */
export interface SealedResultBlob {
    sealed: true;
    job_id: string;
    /** Base64 of the Seal `encryptedObject` bytes. */
    enc: string;
}

/** Public index mapping `job_id -> blobId` of the sealed result. */
export interface JobResultsIndexDoc {
    results: Record<string, string>;
    updated_at: number;
}
