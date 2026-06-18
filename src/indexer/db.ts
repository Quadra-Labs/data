/**
 * SQLite mirror of the agent registry, scores, and jobs. The indexer process
 * writes it from the checkpoint stream; the gateway opens it read-only and serves
 * fast filtered/sorted/paginated reads. WAL mode lets the two processes share the
 * file (one writer, many readers) on the same host.
 */
import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';

/** Bayesian-average confidence constant; must match web/src/lib/score.ts. */
export const SCORE_CONFIDENCE = 20;

export type AgentRow = {
    wallet: string;
    owner: string;
    name: string;
    description: string;
    category: string;
    score: number;
    jobs: number;
    /** Scoreless agents are paid on delivery, never scored, and excluded from the leaderboard. */
    scoreless: boolean;
    /** When the agent was first indexed (epoch ms); used for "newest agents". */
    createdAt: number;
};

/** One recently delivered (released) job across all agents, for the activity feed. */
export type RecentJobRow = {
    jobId: string;
    agent: string;
    agentName: string;
    earned: number;
    paidAtMs: number;
};

/** One day of network activity. */
export type ActivityDay = {
    /** Day start (epoch ms, UTC). */
    day: number;
    jobsSettled: number;
    newAgents: number;
    totalAgents: number;
};

export type RankedAgentRow = AgentRow & { overall: number; rank: number };

export type AgentDetail = AgentRow & { overall: number; rank: number; totalAgents: number };

export type JobRow = {
    jobId: string;
    escrowId: string;
    cost: number;
    earned: number;
    paidAtMs: number;
    status: 'released' | 'refunded' | 'pending';
};

export type AgentsQuery = {
    search?: string;
    category?: string;
    minJobs?: number;
    sort?: 'overall' | 'score' | 'jobs' | 'name';
    dir?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
};

export type AgentsPage = { rows: RankedAgentRow[]; total: number; page: number; pageSize: number };

export type ScoresInput = {
    agents: Record<string, { wallet: string; score: number; total_jobs_delivered: number }>;
};

type DbAgent = {
    wallet: string;
    owner: string;
    name: string;
    description: string;
    category: string;
    score: number;
    total_jobs: number;
    created_at: number;
    scoreless: number;
};

type DbJob = {
    job_id: string;
    escrow_id: string;
    cost: number;
    earned: number;
    paid_at_ms: number;
    status: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
    wallet TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    total_jobs INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    scoreless INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);

CREATE TABLE IF NOT EXISTS jobs (
    escrow_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL DEFAULT '',
    agent TEXT NOT NULL DEFAULT '',
    user TEXT NOT NULL DEFAULT '',
    cost INTEGER NOT NULL DEFAULT 0,
    earned INTEGER NOT NULL DEFAULT 0,
    fee INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    paid_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// `overall` SQL expression, parameterized by the precomputed @mean.
const OVERALL_EXPR = `CASE WHEN total_jobs > 0
    THEN (CAST(score AS REAL) * total_jobs + @mean * ${SCORE_CONFIDENCE}.0) / (total_jobs + ${SCORE_CONFIDENCE}.0)
    ELSE 0 END`;

function toAgentRow(r: DbAgent): AgentRow {
    return {
        wallet: r.wallet,
        owner: r.owner,
        name: r.name,
        description: r.description,
        category: r.category,
        score: r.score,
        jobs: r.total_jobs,
        scoreless: r.scoreless === 1,
        createdAt: r.created_at,
    };
}

function toJobRow(r: DbJob): JobRow {
    return {
        jobId: r.job_id,
        escrowId: r.escrow_id,
        cost: r.cost,
        earned: r.earned,
        paidAtMs: r.paid_at_ms,
        status: r.status === 'released' || r.status === 'refunded' ? r.status : 'pending',
    };
}

export class IndexDb {
    #db: Database.Database;

    constructor(path: string, opts: { readonly?: boolean } = {}) {
        this.#db = new Database(path, { readonly: opts.readonly ?? false });
        this.#db.pragma('busy_timeout = 5000');
        if (!opts.readonly) {
            this.#db.pragma('journal_mode = WAL');
            this.#db.pragma('synchronous = NORMAL');
            this.#db.exec(SCHEMA);
            this.#migrate();
        }
    }

    // Idempotent column additions for DBs created before a column existed. CREATE TABLE IF NOT
    // EXISTS won't add columns to an existing table, so add any missing ones here.
    #migrate(): void {
        const cols = (this.#db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map(
            (c) => c.name,
        );
        if (!cols.includes('scoreless')) {
            this.#db.exec(`ALTER TABLE agents ADD COLUMN scoreless INTEGER NOT NULL DEFAULT 0`);
        }
    }

    close(): void {
        this.#db.close();
    }

    // --- meta / cursor -----------------------------------------------------

    getCursor(): number | undefined {
        const row = this.#db.prepare(`SELECT value FROM meta WHERE key = 'cursor'`).get() as
            | { value: string }
            | undefined;
        return row ? Number(row.value) : undefined;
    }

    setCursor(checkpoint: number): void {
        this.#db
            .prepare(
                `INSERT INTO meta (key, value) VALUES ('cursor', @v)
                 ON CONFLICT(key) DO UPDATE SET value = @v`,
            )
            .run({ v: String(checkpoint) });
    }

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

    // --- writers -----------------------------------------------------------

    /** Insert or refresh an agent's identity, preserving its score/jobs/created_at. */
    upsertAgentIdentity(a: {
        wallet: string;
        owner: string;
        name: string;
        description: string;
        category: string;
        scoreless?: boolean;
        createdAt?: number;
    }): void {
        this.#db
            .prepare(
                `INSERT INTO agents (wallet, owner, name, description, category, scoreless, created_at)
                 VALUES (@wallet, @owner, @name, @description, @category, @scoreless, @createdAt)
                 ON CONFLICT(wallet) DO UPDATE SET
                     owner = excluded.owner,
                     name = excluded.name,
                     description = excluded.description,
                     category = excluded.category,
                     scoreless = excluded.scoreless`,
            )
            .run({ ...a, scoreless: a.scoreless ? 1 : 0, createdAt: a.createdAt ?? Date.now() });
    }

    /** Replace every agent's running score from the agent_scores document. */
    applyScores(doc: ScoresInput): void {
        const stmt = this.#db.prepare(
            `INSERT INTO agents (wallet, score, total_jobs) VALUES (@wallet, @score, @jobs)
             ON CONFLICT(wallet) DO UPDATE SET score = excluded.score, total_jobs = excluded.total_jobs`,
        );
        const tx = this.#db.transaction((scores: ScoresInput['agents']) => {
            for (const s of Object.values(scores)) {
                stmt.run({ wallet: s.wallet, score: s.score, jobs: s.total_jobs_delivered });
            }
        });
        tx(doc.agents);
    }

    applyJobPaid(j: { escrowId: string; jobId: string; agent: string; cost: number; paidAtMs: number }): void {
        this.#db
            .prepare(
                `INSERT INTO jobs (escrow_id, job_id, agent, cost, paid_at_ms, status)
                 VALUES (@escrowId, @jobId, @agent, @cost, @paidAtMs, 'pending')
                 ON CONFLICT(escrow_id) DO UPDATE SET
                     job_id = excluded.job_id, agent = excluded.agent,
                     cost = excluded.cost, paid_at_ms = excluded.paid_at_ms`,
            )
            .run(j);
    }

    applyReleased(j: { escrowId: string; agent: string; earned: number; fee: number }): void {
        const res = this.#db
            .prepare(`UPDATE jobs SET status = 'released', earned = @earned, fee = @fee WHERE escrow_id = @escrowId`)
            .run(j);
        if (res.changes === 0) {
            this.#db
                .prepare(
                    `INSERT INTO jobs (escrow_id, agent, earned, fee, status) VALUES (@escrowId, @agent, @earned, @fee, 'released')`,
                )
                .run(j);
        }
    }

    applyRefunded(j: { escrowId: string; jobId: string; agent: string }): void {
        const res = this.#db
            .prepare(`UPDATE jobs SET status = 'refunded' WHERE escrow_id = @escrowId`)
            .run(j);
        if (res.changes === 0) {
            this.#db
                .prepare(
                    `INSERT INTO jobs (escrow_id, job_id, agent, status) VALUES (@escrowId, @jobId, @agent, 'refunded')`,
                )
                .run(j);
        }
    }

    setJobUser(jobId: string, user: string): void {
        this.#db.prepare(`UPDATE jobs SET user = @user WHERE job_id = @jobId`).run({ jobId, user });
    }

    // --- readers -----------------------------------------------------------

    agentCount(): number {
        return (this.#db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n;
    }

    listAgents(owner?: string): AgentRow[] {
        const rows = (
            owner
                ? this.#db
                      .prepare(`SELECT * FROM agents WHERE lower(owner) = lower(@owner) ORDER BY total_jobs DESC`)
                      .all({ owner })
                : this.#db.prepare(`SELECT * FROM agents ORDER BY total_jobs DESC`).all()
        ) as DbAgent[];
        return rows.map(toAgentRow);
    }

    #mean(): number {
        const row = this.#db
            .prepare(`SELECT COALESCE(AVG(score), 0) AS mean FROM agents WHERE total_jobs > 0`)
            .get() as { mean: number };
        return row.mean;
    }

    getAgentDetail(wallet: string): AgentDetail | null {
        const mean = this.#mean();
        const row = this.#db
            .prepare(
                `WITH scored AS (SELECT *, (${OVERALL_EXPR}) AS overall FROM agents)
                 SELECT s.*,
                     (SELECT COUNT(*) FROM scored) AS total_agents,
                     (SELECT 1 + COUNT(*) FROM scored x WHERE x.overall > s.overall) AS rank
                 FROM scored s WHERE lower(s.wallet) = lower(@wallet)`,
            )
            .get({ mean, wallet }) as (DbAgent & { overall: number; total_agents: number; rank: number }) | undefined;
        if (!row) return null;
        return {
            ...toAgentRow(row),
            overall: row.overall,
            rank: row.rank,
            totalAgents: row.total_agents,
        };
    }

    queryAgents(q: AgentsQuery): AgentsPage {
        const page = Math.max(0, q.page ?? 0);
        const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 10));
        const minJobs = Math.max(0, q.minJobs ?? 0);
        const category = q.category ?? '';
        const search = q.search ? `%${q.search.toLowerCase()}%` : '';
        const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
        const sortCol =
            q.sort === 'score'
                ? 'score'
                : q.sort === 'jobs'
                  ? 'total_jobs'
                  : q.sort === 'name'
                    ? 'name COLLATE NOCASE'
                    : 'overall';

        // Scoreless agents are never scored, so they are excluded from the ranked leaderboard.
        const where = `WHERE scoreless = 0
            AND total_jobs >= @minJobs
            AND (@category = '' OR category = @category)
            AND (@search = '' OR lower(name) LIKE @search OR lower(description) LIKE @search)`;
        const params = {
            mean: this.#mean(),
            minJobs,
            category,
            search,
            limit: pageSize,
            offset: page * pageSize,
        };

        const total = (
            this.#db.prepare(`SELECT COUNT(*) AS n FROM agents ${where}`).get(params) as { n: number }
        ).n;

        const rows = this.#db
            .prepare(
                `SELECT *, (${OVERALL_EXPR}) AS overall FROM agents ${where}
                 ORDER BY ${sortCol} ${dir} LIMIT @limit OFFSET @offset`,
            )
            .all(params) as (DbAgent & { overall: number })[];

        return {
            rows: rows.map((r, i) => ({ ...toAgentRow(r), overall: r.overall, rank: page * pageSize + i + 1 })),
            total,
            page,
            pageSize,
        };
    }

    listAgentJobs(
        agent: string,
        opts: { status?: string; page?: number; pageSize?: number } = {},
    ): { jobs: JobRow[]; total: number } {
        const page = Math.max(0, opts.page ?? 0);
        const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
        const status = opts.status ?? '';
        const where = `WHERE lower(agent) = lower(@agent) AND (@status = '' OR status = @status)`;
        const params = { agent, status, limit: pageSize, offset: page * pageSize };

        const total = (
            this.#db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(params) as { n: number }
        ).n;
        const rows = this.#db
            .prepare(`SELECT * FROM jobs ${where} ORDER BY paid_at_ms DESC LIMIT @limit OFFSET @offset`)
            .all(params) as DbJob[];
        return { jobs: rows.map(toJobRow), total };
    }

    /** Most recent released (delivered + paid) jobs across all agents, newest first. */
    recentJobs(limit = 8): RecentJobRow[] {
        const lim = Math.min(50, Math.max(1, limit));
        return this.#db
            .prepare(
                `SELECT j.job_id AS jobId, j.agent AS agent, j.earned AS earned,
                        j.paid_at_ms AS paidAtMs, COALESCE(a.name, '') AS agentName
                 FROM jobs j LEFT JOIN agents a ON lower(a.wallet) = lower(j.agent)
                 WHERE j.status = 'released'
                 ORDER BY j.paid_at_ms DESC LIMIT @lim`,
            )
            .all({ lim }) as RecentJobRow[];
    }

    /** A daily series for the last `days` days: jobs settled, new agents, cumulative agents. */
    activitySeries(days = 14): ActivityDay[] {
        const n = Math.min(60, Math.max(1, days));
        const DAY = 86_400_000;
        const today = Math.floor(Date.now() / DAY) * DAY; // UTC day start
        const start = today - (n - 1) * DAY;

        const jobRows = this.#db
            .prepare(`SELECT paid_at_ms FROM jobs WHERE status = 'released' AND paid_at_ms >= @start`)
            .all({ start }) as { paid_at_ms: number }[];
        const agentRows = this.#db.prepare(`SELECT created_at FROM agents`).all() as {
            created_at: number;
        }[];

        const jobsByDay = new Map<number, number>();
        for (const r of jobRows) {
            const d = Math.floor(r.paid_at_ms / DAY) * DAY;
            jobsByDay.set(d, (jobsByDay.get(d) ?? 0) + 1);
        }
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
        for (let i = 0; i < n; i++) {
            const day = start + i * DAY;
            const newAgents = newByDay.get(day) ?? 0;
            cumulative += newAgents;
            out.push({ day, jobsSettled: jobsByDay.get(day) ?? 0, newAgents, totalAgents: cumulative });
        }
        return out;
    }
}

/** Open the index read-only, or null if the file does not exist yet. */
export function openReadonly(path: string): IndexDb | null {
    if (!existsSync(path)) return null;
    try {
        return new IndexDb(path, { readonly: true });
    } catch {
        return null;
    }
}
