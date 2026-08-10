/**
 * db.ts — the SQLite mirror of the Flare markets.
 *
 * The indexer writes it from the log tailer; the gateway opens it read-only and serves fast
 * filtered, sorted, paginated reads. WAL mode lets the two share one file — one writer, many
 * readers — ON THE SAME HOST. That constraint is real: if the gateway and the indexer are ever
 * containerised they must stay one pod with one volume.
 *
 * Nothing here is authoritative. Every row is derived from a log the chain already emitted, and
 * every value can be re-read from the contract. `quadra-verify` must never consult it.
 */

import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

import {
    SCHEMA,
    SCHEMA_VERSION,
    MIGRATIONS,
    OVERALL_X100,
    PRIOR_MEAN,
    SCORE_CONFIDENCE,
} from './schema.js';
import type {
    AgentRow,
    AgentDetail,
    AgentsPage,
    AgentsQuery,
    ActivityDay,
    CompetitionRow,
    EndpointRow,
    FailureRow,
    IndexCursor,
    JobRow,
    JobStatus,
    PrizeRow,
    RankedAgentRow,
    RecentJobRow,
    SubmissionRow,
    TrackRow,
    UserJobRow,
} from './types.js';

export { PRIOR_MEAN, SCORE_CONFIDENCE, SCHEMA_VERSION };

const DAY = 86_400_000;
const lower = (s: string): string => s.toLowerCase();
const big = (s: string | null): bigint => BigInt(s ?? '0');

interface DbAgent {
    wallet: string;
    owner: string;
    name: string;
    description: string;
    category: string;
    evaluator_id: string;
    scoreless: number;
    created_at: number;
    scored: number | null;
    total_score: number | null;
    best: number | null;
    overall_x100: number;
}

interface DbJob {
    job_id: string;
    agent: string;
    user: string;
    evaluator_id: string;
    category: string;
    asset: string;
    cost: string;
    earned: string;
    fee: string;
    status: string;
    delivered: number;
    released: number;
    scored: number;
    score: number | null;
    receipt_hash: string;
    ciphertext_hash: string;
    delivered_tx: string;
    delivery_deadline: number;
    lifetime_end: number;
    paid_at_ms: number;
    /**
     * When the escrow closed. Read by `activitySeries` only, and deliberately NOT carried into
     * `JobRow` — the HTTP shape is `web`'s contract and nothing there asks for it yet.
     */
    released_at_ms: number;
    block_number: number;
}

const asStatus = (s: string): JobStatus =>
    s === 'released' || s === 'refunded' || s === 'delivered' ? s : 'pending';

function toAgentRow(r: DbAgent): AgentRow {
    const scored = r.scored ?? 0;
    return {
        wallet: r.wallet,
        owner: r.owner,
        name: r.name,
        description: r.description,
        category: r.category,
        evaluatorId: r.evaluator_id,
        score: scored > 0 ? Math.round((r.total_score ?? 0) / scored) : 0,
        jobs: scored,
        best: r.best ?? 0,
        scoreless: r.scoreless === 1,
        createdAt: r.created_at,
    };
}

function toJobRow(r: DbJob): JobRow {
    return {
        jobId: r.job_id,
        agent: r.agent,
        user: r.user,
        evaluatorId: r.evaluator_id,
        category: r.category,
        asset: r.asset,
        cost: big(r.cost),
        earned: big(r.earned),
        fee: big(r.fee),
        status: asStatus(r.status),
        delivered: r.delivered === 1,
        released: r.released === 1,
        scored: r.scored === 1,
        score: r.score ?? undefined,
        receiptHash: r.receipt_hash,
        ciphertextHash: r.ciphertext_hash,
        deliveredTx: r.delivered_tx,
        deliveryDeadline: r.delivery_deadline,
        lifetimeEnd: r.lifetime_end,
        paidAtMs: r.paid_at_ms,
        blockNumber: r.block_number,
    };
}

interface DbCompetition {
    competition_id: string;
    evaluator_id: string;
    category: string;
    kind: number;
    stake: string;
    seed_prize: string;
    prize_pool: string;
    awarded: string;
    threshold: string;
    resolve_at: number;
    settled: number;
    cancelled: number;
    creator: string;
    receipt_hash: string;
    created_block: number;
    entrants: number;
}

function toCompetitionRow(r: DbCompetition): CompetitionRow {
    return {
        competitionId: r.competition_id,
        evaluatorId: r.evaluator_id,
        category: r.category,
        kind: r.kind,
        stake: big(r.stake),
        seedPrize: big(r.seed_prize),
        prizePool: big(r.prize_pool),
        awarded: big(r.awarded),
        threshold: big(r.threshold),
        resolveAt: r.resolve_at,
        settled: r.settled === 1,
        cancelled: r.cancelled === 1,
        creator: r.creator,

        receiptHash: r.receipt_hash,
        createdBlock: r.created_block,
        entrants: r.entrants,
    };
}

const COMPETITION_SELECT = `
    SELECT c.*,
           (SELECT COUNT(*) FROM submissions s WHERE s.competition_id = c.competition_id) AS entrants
      FROM competitions c`;

/** The agents-with-track projection every ranked read starts from. */
const AGENT_SELECT = `
    SELECT a.*, t.scored, t.total_score, t.best, (${OVERALL_X100}) AS overall_x100
    FROM agents a
    LEFT JOIN tracks t
      ON t.agent = a.wallet
     AND t.category = CASE WHEN @category = '' THEN a.category ELSE @category END`;

/**
 * Rank, computed the way `Passport.rank` computes it.
 *
 * Two properties, and getting either wrong makes the number a lie:
 *
 *   - **The base is the CATEGORY, never the current query.** Ranking over the filtered rows would
 *     make the best match for a search read "rank 1" while the chain says it is fiftieth. Filters
 *     and pagination must not move anyone's rank.
 *   - **Only agents WITH a track are ranked.** `Passport.rank` returns 0 for an agent it has never
 *     recorded, and its loop walks only recorded agents, so an unscored agent neither has a rank
 *     nor pushes anyone else down.
 */
const RANKED_AGENTS = `
    WITH base AS (${AGENT_SELECT}),
         tracked AS (
             SELECT wallet, RANK() OVER (ORDER BY overall_x100 DESC) AS rnk
               FROM base WHERE scored IS NOT NULL
         ),
         ranked AS (
             SELECT b.*, COALESCE(t.rnk, 0) AS rank
               FROM base b LEFT JOIN tracked t ON t.wallet = b.wallet
         )`;

export class IndexDb {
    readonly #db: Database.Database;

    constructor(path: string, opts: { readonly?: boolean } = {}) {
        this.#db = new Database(path, { readonly: opts.readonly ?? false });
        this.#db.pragma('busy_timeout = 5000');
        if (!opts.readonly) {
            this.#db.pragma('journal_mode = WAL');
            this.#db.pragma('synchronous = NORMAL');
            this.#db.exec(SCHEMA);
            // Before the stamp, never after: the stamp is unconditional, so a database that says
            // v3 while missing a v3 column would pass the version check and then throw on the
            // first SELECT that names it.
            this.#migrate();
            this.setMeta('schema_version', String(SCHEMA_VERSION));
        }
    }

    close(): void {
        this.#db.close();
    }

    /**
     * Add any column `SCHEMA` cannot add to a table that already exists.
     *
     * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so every column
     * added after v1 has to arrive this way. `PRAGMA table_info` is what makes it idempotent —
     * SQLite has no `ADD COLUMN IF NOT EXISTS`, and re-adding one is an error, not a no-op.
     */
    #migrate(): void {
        for (const m of MIGRATIONS) {
            const cols = this.#db.prepare(`PRAGMA table_info(${m.table})`).all() as {
                name: string;
            }[];
            if (cols.length === 0) continue; // the table itself is gone; SCHEMA owns that case
            if (cols.some((c) => c.name === m.column)) continue;
            this.#db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
        }
    }

    /**
     * Apply a batch atomically.
     *
     * A tailer pass is all-or-nothing: if applying log 40 of 50 throws, the cursor does not
     * advance and the whole range is retried, so the first 39 must not already be committed or
     * the retry would double-count anything non-idempotent.
     */
    batch<T>(fn: () => T): T {
        return this.#db.transaction(fn)();
    }

    // --- meta and cursor ------------------------------------------------------------------------

    getMeta(key: string): string | undefined {
        const row = this.#db.prepare(`SELECT value FROM meta WHERE key = @key`).get({ key }) as
            | { value: string }
            | undefined;
        return row?.value;
    }

    setMeta(key: string, value: string): void {
        this.#db
            .prepare(
                `INSERT INTO meta (key, value) VALUES (@key, @value)
                 ON CONFLICT(key) DO UPDATE SET value = @value`,
            )
            .run({ key, value });
    }

    schemaVersion(): number {
        return Number(this.getMeta('schema_version') ?? 0);
    }

    /** The last fully applied, confirmed block, with its hash so a reorg can be detected. */
    getCursor(): IndexCursor | undefined {
        const n = this.getMeta('cursor_block');
        if (n === undefined) return undefined;
        return { blockNumber: Number(n), blockHash: this.getMeta('cursor_hash') ?? '' };
    }

    setCursor(cursor: IndexCursor): void {
        this.setMeta('cursor_block', String(cursor.blockNumber));
        this.setMeta('cursor_hash', cursor.blockHash);
    }

    // --- block timestamps -----------------------------------------------------------------------

    putBlock(number: number, ts: number, hash = ''): void {
        this.#db
            .prepare(
                `INSERT INTO blocks (number, ts, hash) VALUES (@number, @ts, @hash)
                 ON CONFLICT(number) DO UPDATE SET ts = excluded.ts, hash = excluded.hash`,
            )
            .run({ number, ts, hash });
    }

    getBlockTs(number: number): number | undefined {
        const row = this.#db.prepare(`SELECT ts FROM blocks WHERE number = @number`).get({ number }) as
            | { ts: number }
            | undefined;
        return row?.ts;
    }

    getBlockHash(number: number): string | undefined {
        const row = this.#db
            .prepare(`SELECT hash FROM blocks WHERE number = @number`)
            .get({ number }) as { hash: string } | undefined;
        return row?.hash && row.hash.length > 0 ? row.hash : undefined;
    }

    // --- writers --------------------------------------------------------------------------------

    /** Insert or refresh identity, preserving anything the chain supplied. */
    upsertAgentIdentity(a: {
        wallet: string;
        owner?: string;
        name?: string;
        description?: string;
        category?: string;
        evaluatorId?: string;
        scoreless?: boolean;
        createdAt?: number;
    }): void {
        this.#db
            .prepare(
                `INSERT INTO agents (wallet, owner, name, description, category, evaluator_id, scoreless, created_at)
                 VALUES (@wallet, @owner, @name, @description, @category, @evaluatorId, @scoreless, @createdAt)
                 ON CONFLICT(wallet) DO UPDATE SET
                     owner        = CASE WHEN excluded.owner        = '' THEN agents.owner        ELSE excluded.owner        END,
                     name         = CASE WHEN excluded.name         = '' THEN agents.name         ELSE excluded.name         END,
                     description  = CASE WHEN excluded.description  = '' THEN agents.description  ELSE excluded.description  END,
                     category     = CASE WHEN excluded.category     = '' THEN agents.category     ELSE excluded.category     END,
                     evaluator_id = CASE WHEN excluded.evaluator_id = '' THEN agents.evaluator_id ELSE excluded.evaluator_id END,
                     scoreless    = excluded.scoreless,
                     -- Keep the EARLIEST sighting: activitySeries counts new agents by this, and a
                     -- later catalog import must not move an agent into the wrong day.
                     created_at   = CASE WHEN agents.created_at = 0 OR agents.created_at > excluded.created_at
                                         THEN excluded.created_at ELSE agents.created_at END`,
            )
            .run({
                wallet: lower(a.wallet),
                owner: a.owner ? lower(a.owner) : '',
                name: a.name ?? '',
                description: a.description ?? '',
                category: a.category ?? '',
                evaluatorId: a.evaluatorId ?? '',
                scoreless: a.scoreless ? 1 : 0,
                createdAt: a.createdAt ?? Date.now(),
            });
    }

    /**
     * Fold one `Passport.Recorded` event into the agent's track.
     *
     * Keyed by (txHash, logIndex) because the fold is ADDITIVE: replaying a block after a reorg
     * would otherwise double every score in it, which is the single most likely way this index
     * silently reports wrong reputation. The insert is the guard — if the event is already
     * recorded, nothing is added.
     */
    applyRecorded(e: {
        txHash: string;
        logIndex: number;
        agent: string;
        category: string;
        sourceId: string;
        score: number;
        blockNumber: number;
        at: number;
    }): void {
        const agent = lower(e.agent);
        const tx = this.#db.transaction(() => {
            const res = this.#db
                .prepare(
                    `INSERT OR IGNORE INTO score_events
                        (tx_hash, log_index, agent, category, source_id, score, block_number, at)
                     VALUES (@txHash, @logIndex, @agent, @category, @sourceId, @score, @blockNumber, @at)`,
                )
                .run({ ...e, agent });
            if (res.changes === 0) return; // already folded

            this.#db
                .prepare(
                    `INSERT INTO tracks (agent, category, scored, total_score, best)
                     VALUES (@agent, @category, 1, @score, @score)
                     ON CONFLICT(agent, category) DO UPDATE SET
                         scored      = tracks.scored + 1,
                         total_score = tracks.total_score + excluded.total_score,
                         best        = MAX(tracks.best, excluded.best)`,
                )
                .run({ agent, category: e.category, score: e.score });

            // A score is the first proof an agent exists, so make sure it has a row to rank.
            this.#db
                .prepare(
                    `INSERT OR IGNORE INTO agents (wallet, category, created_at) VALUES (@agent, @category, @at)`,
                )
                .run({ agent, category: e.category, at: e.at });
        });
        tx();
    }

    applyJobPaid(j: {
        jobId: string;
        user: string;
        agent: string;
        evaluatorId: string;
        category: string;
        asset: string;
        cost: bigint;
        deliveryDeadline: number;
        lifetimeEnd: number;
        paidAtMs: number;
        blockNumber: number;
    }): void {
        this.#db
            .prepare(
                `INSERT INTO jobs (job_id, user, agent, evaluator_id, category, asset, cost,
                                   delivery_deadline, lifetime_end, paid_at_ms, block_number, status)
                 VALUES (@jobId, @user, @agent, @evaluatorId, @category, @asset, @cost,
                         @deliveryDeadline, @lifetimeEnd, @paidAtMs, @blockNumber, 'pending')
                 ON CONFLICT(job_id) DO UPDATE SET
                     user = excluded.user, agent = excluded.agent,
                     evaluator_id = excluded.evaluator_id, category = excluded.category,
                     asset = excluded.asset, cost = excluded.cost,
                     delivery_deadline = excluded.delivery_deadline,
                     lifetime_end = excluded.lifetime_end,
                     paid_at_ms = excluded.paid_at_ms, block_number = excluded.block_number`,
            )
            .run({
                ...j,
                user: lower(j.user),
                agent: lower(j.agent),
                cost: j.cost.toString(),
            });
    }

    applyDelivered(j: {
        jobId: string;
        agent: string;
        ciphertextHash: string;
        txHash: string;
    }): void {
        this.#upsertJob(j.jobId, lower(j.agent), {
            delivered: 1,
            ciphertext_hash: j.ciphertextHash,
            delivered_tx: j.txHash,
            status: 'delivered',
        });
    }

    applyReleased(j: {
        jobId: string;
        agent: string;
        earned: bigint;
        fee: bigint;
        atMs: number;
    }): void {
        this.#upsertJob(j.jobId, lower(j.agent), {
            released: 1,
            earned: j.earned.toString(),
            fee: j.fee.toString(),
            released_at_ms: j.atMs,
            status: 'released',
        });
    }

    /**
     * A refund closes the job on BOTH clocks.
     *
     * `refundNotDelivered` sets `released = true` AND `scored = true`, and records a 0 in the
     * Passport — its own comment calls that "this job's final word on reputation". An index that
     * left `scored` false would disagree with the contract and would keep offering the job to a
     * keeper as still-scorable.
     *
     * `released_at_ms` is written here too, uniformly meaning "the block that closed this escrow".
     * A refund is not settled work and must never reach the activity chart — that is what the
     * `delivered = 1` filter in `activitySeries` is for, not an unwritten column.
     */
    applyRefunded(j: { jobId: string; agent: string; user: string; atMs: number }): void {
        this.#upsertJob(j.jobId, lower(j.agent), {
            released: 1,
            scored: 1,
            score: 0,
            released_at_ms: j.atMs,
            status: 'refunded',
        });
        this.#db
            .prepare(`UPDATE jobs SET user = @user WHERE job_id = @jobId AND user = ''`)
            .run({ jobId: j.jobId, user: lower(j.user) });
    }

    applyScored(j: { jobId: string; agent: string; score: number; receiptHash: string }): void {
        this.#upsertJob(j.jobId, lower(j.agent), {
            scored: 1,
            score: j.score,
            receipt_hash: j.receiptHash,
        });
    }

    /**
     * Apply a partial update, inserting the row if the paying event has not been seen.
     *
     * The insert-if-missing fallback matters on a cold start bounded by FROM_BLOCK: a job paid
     * before the window still produces release and score events inside it, and dropping those
     * would leave the agent's earnings understated.
     */
    #upsertJob(jobId: string, agent: string, fields: Record<string, string | number>): void {
        const cols = Object.keys(fields);
        const sets = cols.map((c) => `${c} = @${c}`).join(', ');
        const res = this.#db
            .prepare(`UPDATE jobs SET ${sets} WHERE job_id = @jobId`)
            .run({ ...fields, jobId });
        if (res.changes === 0) {
            const names = ['job_id', 'agent', ...cols].join(', ');
            const values = ['@jobId', '@agent', ...cols.map((c) => `@${c}`)].join(', ');
            this.#db
                .prepare(`INSERT INTO jobs (${names}) VALUES (${values})`)
                .run({ ...fields, jobId, agent });
        }
    }

    applyCompetitionCreated(c: {
        competitionId: string;
        evaluatorId: string;
        category: string;
        kind: number;
        stake: bigint;
        seedPrize: bigint;
        threshold: bigint;
        resolveAt: number;
        creator: string;
        createdBlock: number;
    }): void {
        this.#db
            .prepare(
                `INSERT INTO competitions (competition_id, evaluator_id, category, kind, stake,
                                           seed_prize, prize_pool, threshold, resolve_at, creator, created_block)
                 VALUES (@competitionId, @evaluatorId, @category, @kind, @stake,
                         @seedPrize, @seedPrize, @threshold, @resolveAt, @creator, @createdBlock)
                 ON CONFLICT(competition_id) DO UPDATE SET
                     evaluator_id = excluded.evaluator_id, category = excluded.category,
                     kind = excluded.kind, stake = excluded.stake, seed_prize = excluded.seed_prize,
                     threshold = excluded.threshold, resolve_at = excluded.resolve_at,
                     creator = excluded.creator, created_block = excluded.created_block`,
            )
            .run({
                ...c,
                creator: lower(c.creator),
                stake: c.stake.toString(),
                seedPrize: c.seedPrize.toString(),
                threshold: c.threshold.toString(),
            });
    }

    applyJoined(c: { competitionId: string; agent: string; stake: bigint }): void {
        const tx = this.#db.transaction(() => {
            this.#adjustPool(c.competitionId, c.stake);
            this.upsertAgentIdentity({ wallet: c.agent });
        });
        tx();
    }

    /**
     * Move a competition's prize pool by `delta`.
     *
     * Read, add, write back — deliberately NOT `CAST(prize_pool AS INTEGER) + @delta` in SQL. That
     * cast is the very overflow the TEXT money columns exist to prevent: a pool past ~9.2 QUADRA
     * would silently saturate inside SQLite.
     *
     * The pool moves in SIX places on chain — seeded at create, raised by each join, lowered by a
     * cancel refund, by a stake withdrawal, by the winners' payout at settlement, and by the
     * creator withdrawing the remainder. Tracking only the first two, which is what this indexer
     * did at first, leaves a settled competition still showing its full pool while the contract
     * holds nothing but dust.
     */
    #adjustPool(competitionId: string, delta: bigint): void {
        const row = this.#db
            .prepare(`SELECT prize_pool FROM competitions WHERE competition_id = @competitionId`)
            .get({ competitionId }) as { prize_pool: string } | undefined;
        if (!row) return;
        const next = big(row.prize_pool) + delta;
        this.#db
            .prepare(`UPDATE competitions SET prize_pool = @pool WHERE competition_id = @competitionId`)
            .run({
                competitionId,
                // The contract can never go negative, but an index that started mid-history can:
                // a withdrawal whose deposit predates FROM_BLOCK has nothing to subtract from.
                pool: (next < 0n ? 0n : next).toString(),
            });
    }

    applyStakeWithdrawn(c: { competitionId: string; amount: bigint }): void {
        this.#adjustPool(c.competitionId, -c.amount);
    }

    applyRemainingWithdrawn(c: { competitionId: string; amount: bigint }): void {
        this.#adjustPool(c.competitionId, -c.amount);
    }

    applySubmitted(s: SubmissionRow): void {
        this.#db
            .prepare(
                `INSERT INTO submissions (competition_id, agent, ciphertext_hash, tx_hash, block_number)
                 VALUES (@competitionId, @agent, @ciphertextHash, @txHash, @blockNumber)
                 ON CONFLICT(competition_id, agent) DO UPDATE SET
                     ciphertext_hash = excluded.ciphertext_hash,
                     tx_hash = excluded.tx_hash, block_number = excluded.block_number`,
            )
            .run({ ...s, agent: lower(s.agent) });
    }

    applyPrizeAwarded(p: PrizeRow & { blockNumber: number }): void {
        this.#db
            .prepare(
                `INSERT INTO prizes (competition_id, agent, rank, amount, block_number)
                 VALUES (@competitionId, @agent, @rank, @amount, @blockNumber)
                 ON CONFLICT(competition_id, agent) DO UPDATE SET
                     rank = excluded.rank, amount = excluded.amount,
                     block_number = excluded.block_number`,
            )
            .run({ ...p, agent: lower(p.agent), amount: p.amount.toString() });
        this.#recomputeAwarded(p.competitionId);
    }

    /**
     * `totalPaid` leaves the pool at settlement — the contract sets `prizePool = prize - totalPaid`
     * and the remainder is dust the creator may reclaim. That dust is emphatically NOT the prize
     * to show for a finished competition, which is why `awarded` is tracked separately.
     */
    applySettled(c: { competitionId: string; receiptHash: string; totalPaid: bigint }): void {
        const tx = this.#db.transaction(() => {
            this.#db
                .prepare(
                    `UPDATE competitions SET settled = 1, receipt_hash = @receiptHash
                      WHERE competition_id = @competitionId`,
                )
                .run({ competitionId: c.competitionId, receiptHash: c.receiptHash });
            this.#adjustPool(c.competitionId, -c.totalPaid);
            this.#recomputeAwarded(c.competitionId);
        });
        tx();
    }

    applyCancelled(c: { competitionId: string; seedReturned: bigint }): void {
        const tx = this.#db.transaction(() => {
            this.#db
                .prepare(`UPDATE competitions SET cancelled = 1 WHERE competition_id = @competitionId`)
                .run({ competitionId: c.competitionId });
            this.#adjustPool(c.competitionId, -c.seedReturned);
        });
        tx();
    }

    /** Recompute the total paid out from the prize rows, so a replay cannot double it. */
    #recomputeAwarded(competitionId: string): void {
        const rows = this.#db
            .prepare(`SELECT amount FROM prizes WHERE competition_id = @competitionId`)
            .all({ competitionId }) as { amount: string }[];
        const total = rows.reduce((t, r) => t + big(r.amount), 0n);
        this.#db
            .prepare(`UPDATE competitions SET awarded = @total WHERE competition_id = @competitionId`)
            .run({ competitionId, total: total.toString() });
    }

    addFailure(f: FailureRow): void {
        this.#db
            .prepare(
                `INSERT INTO job_failures (job_id, agent, kind, reason, source, at)
                 VALUES (@jobId, @agent, @kind, @reason, @source, @at)
                 ON CONFLICT(job_id, source) DO UPDATE SET
                     kind = excluded.kind, reason = excluded.reason, at = excluded.at`,
            )
            .run({ ...f, agent: lower(f.agent) });
    }

    putEndpoint(e: EndpointRow): void {
        this.#db
            .prepare(
                `INSERT INTO agent_endpoints (wallet, url, updated_at) VALUES (@wallet, @url, @updatedAt)
                 ON CONFLICT(wallet) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
            )
            .run({ ...e, wallet: lower(e.wallet) });
    }

    /**
     * Undo everything indexed above `blockNumber`, for a reorg.
     *
     * Score events are deleted and their tracks rebuilt from what remains, rather than subtracted:
     * subtraction assumes the fold was exact, and a rebuild is correct even if it was not.
     */
    rollbackAbove(blockNumber: number): void {
        const tx = this.#db.transaction(() => {
            this.#db.prepare(`DELETE FROM jobs WHERE block_number > @n`).run({ n: blockNumber });
            this.#db.prepare(`DELETE FROM submissions WHERE block_number > @n`).run({ n: blockNumber });
            this.#db.prepare(`DELETE FROM prizes WHERE block_number > @n`).run({ n: blockNumber });
            this.#db
                .prepare(`DELETE FROM competitions WHERE created_block > @n`)
                .run({ n: blockNumber });
            this.#db.prepare(`DELETE FROM score_events WHERE block_number > @n`).run({ n: blockNumber });
            this.#db.prepare(`DELETE FROM blocks WHERE number > @n`).run({ n: blockNumber });
            this.#db.prepare(`DELETE FROM tracks`).run();
            this.#db
                .prepare(
                    `INSERT INTO tracks (agent, category, scored, total_score, best)
                     SELECT agent, category, COUNT(*), SUM(score), MAX(score)
                     FROM score_events GROUP BY agent, category`,
                )
                .run();
        });
        tx();
    }

    // --- readers --------------------------------------------------------------------------------

    agentCount(): number {
        return (this.#db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n;
    }

    jobCount(): number {
        return (this.#db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;
    }

    listAgents(owner?: string): AgentRow[] {
        const rows = this.#db
            .prepare(
                `${AGENT_SELECT}
                 WHERE (@owner = '' OR a.owner = @owner)
                 ORDER BY COALESCE(t.scored, 0) DESC`,
            )
            .all({ category: '', owner: owner ? lower(owner) : '' }) as DbAgent[];
        return rows.map(toAgentRow);
    }

    getTrack(agent: string, category: string): TrackRow | undefined {
        const row = this.#db
            .prepare(
                `SELECT agent, category, scored, total_score, best FROM tracks
                  WHERE agent = @agent AND category = @category`,
            )
            .get({ agent: lower(agent), category }) as
            | { agent: string; category: string; scored: number; total_score: number; best: number }
            | undefined;
        if (!row) return undefined;
        return {
            agent: row.agent,
            category: row.category,
            scored: row.scored,
            totalScore: row.total_score,
            best: row.best,
            overallX100: Math.floor(
                ((row.total_score + PRIOR_MEAN * SCORE_CONFIDENCE) * 100) /
                    (row.scored + SCORE_CONFIDENCE),
            ),
        };
    }

    getAgentDetail(wallet: string, category = ''): AgentDetail | undefined {
        const row = this.#db
            .prepare(
                `${RANKED_AGENTS}
                 SELECT r.*, (SELECT COUNT(*) FROM ranked) AS total_agents
                   FROM ranked r WHERE r.wallet = @wallet`,
            )
            .get({ wallet: lower(wallet), category }) as
            | (DbAgent & { rank: number; total_agents: number })
            | undefined;
        if (!row) return undefined;
        return {
            ...toAgentRow(row),
            overall: row.overall_x100 / 100,
            rank: row.rank,
            totalAgents: row.total_agents,
        };
    }

    /**
     * The ranked leaderboard.
     *
     * `rank` is a DENSE competition rank computed over the whole filtered set — ties share a rank —
     * exactly as `Passport.rank` does. The Sui version assigned `page * pageSize + i + 1`, a
     * positional number, so the same agent got different ranks from `/agents/query` and
     * `/agents/:wallet`, and the numbers changed as you paged.
     */
    queryAgents(q: AgentsQuery): AgentsPage {
        const page = Math.max(0, q.page ?? 0);
        const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 10));
        const params = {
            category: q.category ?? '',
            minJobs: Math.max(0, q.minJobs ?? 0),
            search: q.search ? `%${q.search.toLowerCase()}%` : '',
            limit: pageSize,
            offset: page * pageSize,
        };
        const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
        const sortCol =
            q.sort === 'score'
                ? 'total_score'
                : q.sort === 'jobs'
                  ? 'scored'
                  : q.sort === 'name'
                    ? 'name COLLATE NOCASE'
                    : 'overall_x100';

        // Scoreless agents are paid on delivery and never scored, so they have no place on a
        // ranked board. Keeping the filter is only meaningful because the catalog sets the flag.
        const where = `WHERE scoreless = 0
            AND COALESCE(scored, 0) >= @minJobs
            AND (@category = '' OR category = @category)
            AND (@search = '' OR lower(name) LIKE @search OR lower(description) LIKE @search)`;

        const total = (
            this.#db
                .prepare(`${RANKED_AGENTS} SELECT COUNT(*) AS n FROM ranked ${where}`)
                .get(params) as { n: number }
        ).n;

        // Rank comes from RANKED_AGENTS, which scopes it to the category. Filtering and paging
        // happen after, so neither can move anyone's rank.
        const rows = this.#db
            .prepare(
                `${RANKED_AGENTS}
                 SELECT * FROM ranked ${where} ORDER BY ${sortCol} ${dir} LIMIT @limit OFFSET @offset`,
            )
            .all(params) as (DbAgent & { rank: number })[];

        return {
            rows: rows.map(
                (r): RankedAgentRow => ({
                    ...toAgentRow(r),
                    overall: r.overall_x100 / 100,
                    rank: r.rank,
                }),
            ),
            total,
            page,
            pageSize,
        };
    }

    getJob(jobId: string): JobRow | undefined {
        const row = this.#db.prepare(`SELECT * FROM jobs WHERE job_id = @jobId`).get({ jobId }) as
            | DbJob
            | undefined;
        return row ? toJobRow(row) : undefined;
    }

    /**
     * Jobs delivered but not yet scored whose window has closed.
     *
     * This is what lets the keeper stop guessing with `recentDeliveredJobs(lookbackBlocks)`, where
     * a job that fell outside the lookback is never scored and nothing says so. A correctness fix,
     * not an optimisation.
     */
    dueJobs(atSecs: number, limit = 100): JobRow[] {
        const rows = this.#db
            .prepare(
                `SELECT * FROM jobs
                  WHERE delivered = 1 AND scored = 0 AND released = 1 AND lifetime_end <= @at
                  ORDER BY lifetime_end ASC LIMIT @limit`,
            )
            .all({ at: atSecs, limit: Math.min(500, Math.max(1, limit)) }) as DbJob[];
        return rows.map(toJobRow);
    }

    listAgentJobs(
        agent: string,
        opts: { status?: string | undefined; page?: number | undefined; pageSize?: number | undefined } = {},
    ): { jobs: JobRow[]; total: number } {
        const page = Math.max(0, opts.page ?? 0);
        const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
        const params = {
            agent: lower(agent),
            status: opts.status ?? '',
            limit: pageSize,
            offset: page * pageSize,
        };
        const where = `WHERE agent = @agent AND (@status = '' OR status = @status)`;
        const total = (
            this.#db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(params) as { n: number }
        ).n;
        const rows = this.#db
            .prepare(`SELECT * FROM jobs ${where} ORDER BY paid_at_ms DESC LIMIT @limit OFFSET @offset`)
            .all(params) as DbJob[];
        return { jobs: rows.map(toJobRow), total };
    }

    listUserJobs(
        user: string,
        opts: { status?: string | undefined; page?: number | undefined; pageSize?: number | undefined } = {},
    ): { jobs: UserJobRow[]; total: number } {
        const page = Math.max(0, opts.page ?? 0);
        const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
        const params = {
            user: lower(user),
            status: opts.status ?? '',
            limit: pageSize,
            offset: page * pageSize,
        };
        const where = `WHERE j.user = @user AND (@status = '' OR j.status = @status)`;
        const total = (
            this.#db.prepare(`SELECT COUNT(*) AS n FROM jobs j ${where}`).get(params) as { n: number }
        ).n;
        const rows = this.#db
            .prepare(
                `SELECT j.*, COALESCE(a.name, '') AS agent_name
                   FROM jobs j LEFT JOIN agents a ON a.wallet = j.agent
                 ${where} ORDER BY j.paid_at_ms DESC LIMIT @limit OFFSET @offset`,
            )
            .all(params) as (DbJob & { agent_name: string })[];
        return {
            jobs: rows.map((r) => ({ ...toJobRow(r), agentName: r.agent_name })),
            total,
        };
    }

    recentJobs(limit = 8): RecentJobRow[] {
        const rows = this.#db
            .prepare(
                `SELECT j.job_id, j.agent, j.earned, j.paid_at_ms, COALESCE(a.name, '') AS agent_name
                   FROM jobs j LEFT JOIN agents a ON a.wallet = j.agent
                  WHERE j.released = 1 AND j.delivered = 1
                  ORDER BY j.paid_at_ms DESC LIMIT @lim`,
            )
            .all({ lim: Math.min(50, Math.max(1, limit)) }) as {
            job_id: string;
            agent: string;
            earned: string;
            paid_at_ms: number;
            agent_name: string;
        }[];
        return rows.map((r) => ({
            jobId: r.job_id,
            agent: r.agent,
            agentName: r.agent_name,
            earned: big(r.earned),
            paidAtMs: r.paid_at_ms,
        }));
    }

    /** A daily series: jobs settled, new agents, cumulative agents, and TEE settlements. */
    activitySeries(days = 14): ActivityDay[] {
        const n = Math.min(60, Math.max(1, days));
        const today = Math.floor(Date.now() / DAY) * DAY;
        const start = today - (n - 1) * DAY;

        const jobRows = this.#db
            // `released` alone would count REFUNDS as settled work: a refund also sets released,
            // so a job nobody delivered — where the buyer got their money back — would appear in
            // the activity chart as a completed job. Delivered AND released is the real thing.
            //
            // Bucketed on `released_at_ms`, not `paid_at_ms`. The series is "jobs SETTLED per day":
            // a job paid on Monday and settled on Friday belongs to Friday, and a job paid before
            // the window but settled inside it belongs in the chart at all — the old `paid_at_ms >=
            // @start` bound dropped it entirely.
            //
            // Rows written before schema v3 carry 0 here and are skipped by the bucketer, so old
            // settlements are missing from the chart until the index is rebuilt. A redeploy forces
            // a rebuild anyway; on a database that was only ALTERed, expect a short flat head.
            .prepare(
                `SELECT released_at_ms FROM jobs
                  WHERE released = 1 AND delivered = 1 AND released_at_ms >= @start`,
            )
            .all({ start }) as { released_at_ms: number }[];
        const agentRows = this.#db.prepare(`SELECT created_at FROM agents`).all() as {
            created_at: number;
        }[];
        const scoreRows = this.#db
            .prepare(`SELECT at FROM score_events WHERE at >= @start`)
            .all({ start }) as { at: number }[];

        const bucket = (rows: { [k: string]: number }[], key: string): Map<number, number> => {
            const m = new Map<number, number>();
            for (const r of rows) {
                const v = r[key] ?? 0;
                if (v <= 0) continue;
                const d = Math.floor(v / DAY) * DAY;
                m.set(d, (m.get(d) ?? 0) + 1);
            }
            return m;
        };

        const jobsByDay = bucket(jobRows, 'released_at_ms');
        const scoresByDay = bucket(scoreRows, 'at');
        const newByDay = new Map<number, number>();
        let totalBefore = 0;
        for (const r of agentRows) {
            if (r.created_at < start) totalBefore += 1;
            else {
                const d = Math.floor(r.created_at / DAY) * DAY;
                newByDay.set(d, (newByDay.get(d) ?? 0) + 1);
            }
        }

        const out: ActivityDay[] = [];
        let cumulative = totalBefore;
        for (let i = 0; i < n; i += 1) {
            const day = start + i * DAY;
            const newAgents = newByDay.get(day) ?? 0;
            cumulative += newAgents;
            out.push({
                day,
                jobsSettled: jobsByDay.get(day) ?? 0,
                newAgents,
                totalAgents: cumulative,
                scoresRecorded: scoresByDay.get(day) ?? 0,
            });
        }
        return out;
    }

    listCompetitions(limit = 20): CompetitionRow[] {
        const rows = this.#db
            .prepare(`${COMPETITION_SELECT} ORDER BY c.created_block DESC LIMIT @lim`)
            .all({ lim: Math.min(200, Math.max(1, limit)) }) as DbCompetition[];
        return rows.map(toCompetitionRow);
    }

    getCompetition(competitionId: string): CompetitionRow | undefined {
        const row = this.#db
            .prepare(`${COMPETITION_SELECT} WHERE c.competition_id = @competitionId`)
            .get({ competitionId }) as DbCompetition | undefined;
        return row ? toCompetitionRow(row) : undefined;
    }

    listSubmissions(competitionId: string): SubmissionRow[] {
        const rows = this.#db
            .prepare(`SELECT * FROM submissions WHERE competition_id = @competitionId`)
            .all({ competitionId }) as {
            competition_id: string;
            agent: string;
            ciphertext_hash: string;
            tx_hash: string;
            block_number: number;
        }[];
        return rows.map((r) => ({
            competitionId: r.competition_id,
            agent: r.agent,
            ciphertextHash: r.ciphertext_hash,
            txHash: r.tx_hash,
            blockNumber: r.block_number,
        }));
    }

    listPrizes(competitionId: string): PrizeRow[] {
        const rows = this.#db
            .prepare(
                `SELECT * FROM prizes WHERE competition_id = @competitionId ORDER BY rank ASC`,
            )
            .all({ competitionId }) as {
            competition_id: string;
            agent: string;
            rank: number;
            amount: string;
        }[];
        return rows.map((r) => ({
            competitionId: r.competition_id,
            agent: r.agent,
            rank: r.rank,
            amount: big(r.amount),
        }));
    }

    listFailures(limit = 50): FailureRow[] {
        const rows = this.#db
            .prepare(`SELECT * FROM job_failures ORDER BY at DESC LIMIT @lim`)
            .all({ lim: Math.min(200, Math.max(1, limit)) }) as {
            job_id: string;
            agent: string;
            kind: string;
            reason: string;
            source: string;
            at: number;
        }[];
        return rows.map((r) => ({
            jobId: r.job_id,
            agent: r.agent,
            kind: r.kind === 'failed' ? 'failed' : 'delayed',
            reason: r.reason,
            source: r.source,
            at: r.at,
        }));
    }

    getEndpoint(wallet: string): EndpointRow | undefined {
        const row = this.#db
            .prepare(`SELECT * FROM agent_endpoints WHERE wallet = @wallet`)
            .get({ wallet: lower(wallet) }) as
            | { wallet: string; url: string; updated_at: number }
            | undefined;
        return row ? { wallet: row.wallet, url: row.url, updatedAt: row.updated_at } : undefined;
    }
}

/**
 * Open the index read-only, or undefined when it is unusable.
 *
 * The schema-version check is the part the Sui version lacked: a read-only open runs no migration,
 * so a database written by an older build failed at the first SELECT with a missing-column error
 * rather than saying what was wrong.
 */
export function openReadonly(path: string): IndexDb | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const db = new IndexDb(path, { readonly: true });
        if (db.schemaVersion() !== SCHEMA_VERSION) {
            console.warn(
                `[index] ${path} is schema v${db.schemaVersion()}, this build expects ` +
                    `v${SCHEMA_VERSION}; serving live reads until the indexer migrates it`,
            );
            db.close();
            return undefined;
        }
        return db;
    } catch {
        return undefined;
    }
}
