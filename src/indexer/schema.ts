/**
 * schema.ts — the index DDL and its version.
 *
 * Notes that matter more than the SQL:
 *
 * **Money is TEXT.** Every amount is a decimal wei string, read back as a bigint. QUADRA has 18
 * decimals, so a single token is 1e18 and SQLite's INTEGER runs out below ten of them.
 *
 * **Jobs are keyed by `job_id`.** The Sui schema keyed on `escrow_id`, a separate object. Flare
 * has no such object — `JobEscrow` keys everything by `bytes32 jobId` — and keeping the old key
 * would make every release event insert a phantom row instead of updating the real one.
 *
 * **Every indexed row carries `block_number` and `log_index`.** That is what makes a reorg
 * rollback deterministic: delete above a block and replay. Without them a rewind has no handle.
 *
 * **Reputation lives in `tracks`, keyed by (agent, category).** `Passport` is
 * `mapping(address => mapping(bytes32 => Track))`, so a single global score per agent — which is
 * what Sui had — cannot represent it.
 */

/**
 * Bumped whenever the DDL changes in a way an existing file cannot satisfy. A read-only opener
 * checks it and refuses rather than failing at the first SELECT, which is what the Sui version did
 * when it met a database created before its newest column.
 */
export const SCHEMA_VERSION = 3;

/**
 * Columns added after a table shipped, applied one by one to a database that already exists.
 *
 * `SCHEMA` above is all `CREATE TABLE IF NOT EXISTS`, so on an existing file it is a NO-OP — a new
 * column in an existing table is never created, while the version stamp is written unconditionally.
 * The database would then claim to be v3 and throw at the first SELECT naming the missing column.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the applier reads `PRAGMA table_info` and skips what
 * is already there, which makes this idempotent and safe to run on a fresh file too.
 */
export const MIGRATIONS: readonly { table: string; column: string; ddl: string }[] = [
    // v3: bucket the activity chart on when a job SETTLED, not when it was paid for.
    { table: 'jobs', column: 'released_at_ms', ddl: 'INTEGER NOT NULL DEFAULT 0' },
];

export const SCHEMA = `
-- Agent identity. Flare has no on-chain agent registry, so name/description/owner come from a
-- checked-in catalog; rows can also be created by chain activity alone, with empty identity.
CREATE TABLE IF NOT EXISTS agents (
    wallet TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    evaluator_id TEXT NOT NULL DEFAULT '',
    scoreless INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);
CREATE INDEX IF NOT EXISTS idx_agents_category ON agents(category);

-- The Passport mirror: one row per (agent, category), matching the contract's own shape.
CREATE TABLE IF NOT EXISTS tracks (
    agent TEXT NOT NULL,
    category TEXT NOT NULL,
    scored INTEGER NOT NULL DEFAULT 0,
    total_score INTEGER NOT NULL DEFAULT 0,
    best INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent, category)
);
CREATE INDEX IF NOT EXISTS idx_tracks_category ON tracks(category);

-- Individual Recorded events, keyed by their log position. The track above is ADDITIVE, so a
-- replay after a reorg would double-count it; this table makes the fold idempotent.
CREATE TABLE IF NOT EXISTS score_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    agent TEXT NOT NULL,
    category TEXT NOT NULL,
    source_id TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    block_number INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_score_events_block ON score_events(block_number);
CREATE INDEX IF NOT EXISTS idx_score_events_agent ON score_events(agent, category);

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL DEFAULT '',
    user TEXT NOT NULL DEFAULT '',
    evaluator_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    asset TEXT NOT NULL DEFAULT '',
    cost TEXT NOT NULL DEFAULT '0',
    earned TEXT NOT NULL DEFAULT '0',
    fee TEXT NOT NULL DEFAULT '0',
    status TEXT NOT NULL DEFAULT 'pending',
    delivered INTEGER NOT NULL DEFAULT 0,
    released INTEGER NOT NULL DEFAULT 0,
    scored INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    receipt_hash TEXT NOT NULL DEFAULT '',
    ciphertext_hash TEXT NOT NULL DEFAULT '',
    delivered_tx TEXT NOT NULL DEFAULT '',
    delivery_deadline INTEGER NOT NULL DEFAULT 0,
    lifetime_end INTEGER NOT NULL DEFAULT 0,
    paid_at_ms INTEGER NOT NULL DEFAULT 0,
    -- When the escrow CLOSED, in either direction. paid_at_ms is when the buyer hired the agent,
    -- which can be days earlier -- activitySeries buckets on THIS one.
    released_at_ms INTEGER NOT NULL DEFAULT 0,
    block_number INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_block ON jobs(block_number);
-- Serves "which jobs are due to be scored", which the keeper needs and which a lookback log scan
-- answers incorrectly: a job that fell outside the window is never scored, silently.
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(delivered, scored, lifetime_end);

CREATE TABLE IF NOT EXISTS competitions (
    competition_id TEXT PRIMARY KEY,
    evaluator_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    kind INTEGER NOT NULL DEFAULT 0,
    stake TEXT NOT NULL DEFAULT '0',
    seed_prize TEXT NOT NULL DEFAULT '0',
    prize_pool TEXT NOT NULL DEFAULT '0',
    awarded TEXT NOT NULL DEFAULT '0',
    threshold TEXT NOT NULL DEFAULT '0',
    resolve_at INTEGER NOT NULL DEFAULT 0,
    settled INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    creator TEXT NOT NULL DEFAULT '',
    receipt_hash TEXT NOT NULL DEFAULT '',
    created_block INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_competitions_resolve ON competitions(resolve_at);
CREATE INDEX IF NOT EXISTS idx_competitions_block ON competitions(created_block);

CREATE TABLE IF NOT EXISTS submissions (
    competition_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    ciphertext_hash TEXT NOT NULL DEFAULT '',
    tx_hash TEXT NOT NULL DEFAULT '',
    block_number INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (competition_id, agent)
);
CREATE INDEX IF NOT EXISTS idx_submissions_block ON submissions(block_number);

CREATE TABLE IF NOT EXISTS prizes (
    competition_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0,
    amount TEXT NOT NULL DEFAULT '0',
    block_number INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (competition_id, agent)
);
CREATE INDEX IF NOT EXISTS idx_prizes_block ON prizes(block_number);

CREATE TABLE IF NOT EXISTS job_failures (
    job_id TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'delayed',
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'chain',
    at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, source)
);

CREATE TABLE IF NOT EXISTS agent_endpoints (
    wallet TEXT PRIMARY KEY,
    url TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- Block timestamps, so N logs in one block cost one eth_getBlockByNumber rather than N. EVM
-- events carry no time field at all, which the Sui events did.
CREATE TABLE IF NOT EXISTS blocks (
    number INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * The Bayesian reputation, x100, computed by EXACTLY the formula `Passport.overall` uses:
 *
 *     ((totalScore + PRIOR_MEAN * CONFIDENCE) * 100) / (scored + CONFIDENCE)
 *
 * with integer division at the end. Both operands are integers here, so SQLite divides as
 * integers and the result matches the contract to the unit.
 *
 * The Sui index used a DIFFERENT formula — the prior was the observed mean of scored agents rather
 * than a fixed 50, and an unscored agent read as 0 rather than the prior. Two formulas is the
 * classic silent bug: the leaderboard reorders when the indexer restarts, and the site disagrees
 * with the chain about who is first. The contract wins; this mirrors it.
 */
export const PRIOR_MEAN = 50;
export const SCORE_CONFIDENCE = 20;

export const OVERALL_X100 = `((COALESCE(t.total_score, 0) + ${PRIOR_MEAN} * ${SCORE_CONFIDENCE}) * 100) / (COALESCE(t.scored, 0) + ${SCORE_CONFIDENCE})`;
