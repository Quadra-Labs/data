/**
 * The read model the index serves.
 *
 * These shapes are the contract with every consumer of the HTTP gateway, so they change
 * deliberately or not at all.
 *
 * One change from the Sui original is not cosmetic: **every money field is a bigint, stored as a
 * decimal string.** Sui amounts are MIST and fit an INTEGER column; QUADRA has 18 decimals and a
 * fixed supply of 1e11 tokens, so the total supply alone is 1e29 wei. SQLite's INTEGER tops out
 * near 9.2e18 — under ten whole QUADRA — and a JS number loses precision above 2^53. Keeping these
 * as numbers would silently corrupt every amount in the system.
 */

/** A lowercased 0x-hex address. Lowercasing is what makes the SQL `lower(...)` joins work. */
export type AddressHex = string;

export interface AgentRow {
    wallet: AddressHex;
    /** The operator that runs this agent. Empty when the agent is only known from chain activity. */
    owner: AddressHex;
    name: string;
    description: string;
    /** keccak(evaluatorId) hex — the Passport dimension, not a human label. */
    category: string;
    /** The human-readable evaluator id, kept so a category never renders as a bytes32. */
    evaluatorId: string;
    /** Mean score, 0-100. Mirrors totalScore/scored from the Passport track. */
    score: number;
    /** How many results have been scored. */
    jobs: number;
    /** Best single score seen. */
    best: number;
    /** Paid on delivery, never scored, and excluded from the ranked leaderboard. */
    scoreless: boolean;
    /** First seen, epoch ms. */
    createdAt: number;
}

export type RankedAgentRow = AgentRow & { overall: number; rank: number };
export type AgentDetail = AgentRow & { overall: number; rank: number; totalAgents: number };

export type JobStatus = 'pending' | 'delivered' | 'released' | 'refunded';

export interface JobRow {
    jobId: string;
    agent: AddressHex;
    user: AddressHex;
    evaluatorId: string;
    category: string;
    cost: bigint;
    earned: bigint;
    fee: bigint;
    status: JobStatus;
    delivered: boolean;
    released: boolean;
    scored: boolean;
    /** 0-100 once scored, else undefined. */
    score: number | undefined;
    receiptHash: string;
    /** keccak(ciphertext) from deliver, so a client can fetch and check the result. */
    ciphertextHash: string;
    /** The transaction that delivered, so the ciphertext is one getTransaction away. */
    deliveredTx: string;
    /** The asset the job scoped itself to, decoded from params. */
    asset: string;
    deliveryDeadline: number;
    lifetimeEnd: number;
    paidAtMs: number;
    blockNumber: number;
}

/** A job from the payer's side, with the agent's name joined in. */
export type UserJobRow = JobRow & { agentName: string };

/** One recently released job across all agents, for the activity feed. */
export interface RecentJobRow {
    jobId: string;
    agent: AddressHex;
    agentName: string;
    earned: bigint;
    paidAtMs: number;
}

/** One day of network activity. */
export interface ActivityDay {
    /** Day start, epoch ms, UTC. */
    day: number;
    jobsSettled: number;
    newAgents: number;
    totalAgents: number;
    /** Settlements the TEE signed that day — the number the bounty demo actually wants to show. */
    scoresRecorded: number;
}

export interface AgentsQuery {
    search?: string | undefined;
    /** A category hex, or an evaluator id — both are accepted and resolved to the hex. */
    category?: string | undefined;
    minJobs?: number | undefined;
    sort?: 'overall' | 'score' | 'jobs' | 'name' | undefined;
    dir?: 'asc' | 'desc' | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
}

export interface AgentsPage {
    rows: RankedAgentRow[];
    total: number;
    page: number;
    pageSize: number;
}

/** One agent's Passport track in one category, mirrored from the contract. */
export interface TrackRow {
    agent: AddressHex;
    category: string;
    scored: number;
    totalScore: number;
    best: number;
    /** The contract's Bayesian value, x100, computed by the same integer formula. */
    overallX100: number;
}

export interface CompetitionRow {
    competitionId: string;
    evaluatorId: string;
    category: string;
    kind: number;
    stake: bigint;
    seedPrize: bigint;
    prizePool: bigint;
    awarded: bigint;
    threshold: bigint;
    resolveAt: number;
    settled: boolean;
    cancelled: boolean;
    creator: AddressHex;
    /** The anchored receipt hash, from Settled. Empty until the competition settles. */
    receiptHash: string;
    createdBlock: number;
    entrants: number;
}

export interface SubmissionRow {
    competitionId: string;
    agent: AddressHex;
    ciphertextHash: string;
    txHash: string;
    blockNumber: number;
}

export interface PrizeRow {
    competitionId: string;
    agent: AddressHex;
    rank: number;
    amount: bigint;
}

export type FailureKind = 'delayed' | 'failed';

/**
 * Why a job did not pay out.
 *
 * The chain records THAT a job refunded; it never records why. On the Flare side that reason —
 * which template field was malformed — exists only in an intake-engine log line and is lost
 * afterwards. A refunded job with no stated reason is exactly what a marketplace user complains
 * about, so it is captured here.
 */
export interface FailureRow {
    jobId: string;
    agent: AddressHex;
    kind: FailureKind;
    reason: string;
    /** 'chain' for one derived from a refund event, 'intake' for one reported by the engine. */
    source: string;
    at: number;
}

/** Where an agent can be reached, self-published and signed. */
export interface EndpointRow {
    wallet: AddressHex;
    url: string;
    updatedAt: number;
}

/** How far the index has caught up. */
export interface IndexCursor {
    /** The last block whose logs are fully applied AND confirmed. */
    blockNumber: number;
    /** That block's hash, so a reorg can be detected by re-reading it. */
    blockHash: string;
}
