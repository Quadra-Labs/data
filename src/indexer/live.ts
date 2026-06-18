/**
 * Live fallbacks for the index-backed read endpoints, used when the SQLite mirror
 * is missing or empty (the indexer has not run yet). These reproduce the slow path
 * (on-chain enumeration + Walrus read + event scans) so the gateway never breaks;
 * they are identical in shape to the IndexDb readers.
 */
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import type { DataLayer } from '../index.js';
import {
    SCORE_CONFIDENCE,
    type AgentDetail,
    type AgentRow,
    type AgentsPage,
    type AgentsQuery,
    type JobRow,
} from './db.js';

const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));
const sameAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Merge the on-chain registry with the Walrus scores doc into joined rows. */
export async function liveAgentRows(dl: DataLayer, owner?: string): Promise<AgentRow[]> {
    const [agents, scoresDoc] = await Promise.all([
        dl.agents.list(),
        dl.agentScores.read().catch(() => ({ agents: {} })),
    ]);
    const scores = (scoresDoc as { agents: Record<string, { score: number; total_jobs_delivered: number }> })
        .agents;
    let rows: AgentRow[] = agents.map((a) => ({
        wallet: a.wallet,
        owner: a.owner,
        name: a.name,
        description: a.description,
        category: a.category,
        score: scores[a.wallet]?.score ?? 0,
        jobs: scores[a.wallet]?.total_jobs_delivered ?? 0,
    }));
    if (owner) rows = rows.filter((r) => sameAddr(r.owner, owner));
    return rows;
}

function meanScore(rows: AgentRow[]): number {
    const scored = rows.filter((r) => r.jobs > 0);
    if (scored.length === 0) return 0;
    return scored.reduce((sum, r) => sum + r.score, 0) / scored.length;
}

function overall(r: AgentRow, mean: number): number {
    if (r.jobs <= 0) return 0;
    return (r.score * r.jobs + mean * SCORE_CONFIDENCE) / (r.jobs + SCORE_CONFIDENCE);
}

/** Filter, sort, and paginate rows the same way IndexDb.queryAgents does. */
export function rankAndPage(rows: AgentRow[], q: AgentsQuery): AgentsPage {
    const mean = meanScore(rows);
    const search = (q.search ?? '').toLowerCase();
    const category = q.category ?? '';
    const minJobs = q.minJobs ?? 0;
    const filtered = rows.filter(
        (r) =>
            r.jobs >= minJobs &&
            (category === '' || r.category === category) &&
            (search === '' ||
                r.name.toLowerCase().includes(search) ||
                r.description.toLowerCase().includes(search)),
    );

    const dir = q.dir === 'asc' ? 1 : -1;
    const sort = q.sort ?? 'overall';
    filtered.sort((a, b) => {
        if (sort === 'name') return dir * a.name.localeCompare(b.name);
        if (sort === 'score') return dir * (a.score - b.score);
        if (sort === 'jobs') return dir * (a.jobs - b.jobs);
        return dir * (overall(a, mean) - overall(b, mean));
    });

    const page = Math.max(0, q.page ?? 0);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 10));
    const slice = filtered.slice(page * pageSize, page * pageSize + pageSize);
    return {
        rows: slice.map((r, i) => ({ ...r, overall: overall(r, mean), rank: page * pageSize + i + 1 })),
        total: filtered.length,
        page,
        pageSize,
    };
}

/** One agent's row with its overall score and global rank, computed live. */
export async function liveAgentDetail(dl: DataLayer, wallet: string): Promise<AgentDetail | null> {
    const rows = await liveAgentRows(dl);
    const mean = meanScore(rows);
    const target = rows.find((r) => sameAddr(r.wallet, wallet));
    if (!target) return null;
    const o = overall(target, mean);
    const rank = 1 + rows.filter((r) => overall(r, mean) > o).length;
    return { ...target, overall: o, rank, totalAgents: rows.length };
}

async function queryCapped(
    sui: SuiJsonRpcClient,
    type: string,
    maxPages = 10,
): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null | undefined;
    for (let i = 0; i < maxPages; i += 1) {
        const page = await sui.queryEvents({
            query: { MoveEventType: type },
            cursor,
            limit: 50,
            order: 'descending',
        });
        for (const event of page.data) if (event.parsedJson) out.push(event.parsedJson as Record<string, unknown>);
        if (!page.hasNextPage) break;
        cursor = page.nextCursor as { txDigest: string; eventSeq: string } | null | undefined;
    }
    return out;
}

/** Reconstruct an agent's jobs from intake events (the original slow client path). */
export async function liveAgentJobs(
    sui: SuiJsonRpcClient,
    quadraPackageId: string,
    agent: string,
): Promise<JobRow[]> {
    const [paid, released, refunded] = await Promise.all([
        queryCapped(sui, `${quadraPackageId}::intake::JobPaid`),
        queryCapped(sui, `${quadraPackageId}::intake::PaymentReleased`),
        queryCapped(sui, `${quadraPackageId}::intake::JobNotDelivered`),
    ]);

    const earnedByEscrow = new Map<string, number>();
    for (const e of released) {
        if (sameAddr(str(e.agent_wallet), agent)) earnedByEscrow.set(str(e.escrow_id), num(e.agent_amount));
    }
    const refundedEscrows = new Set<string>();
    for (const e of refunded) {
        if (sameAddr(str(e.agent_wallet), agent)) refundedEscrows.add(str(e.escrow_id));
    }

    const jobs: JobRow[] = [];
    for (const e of paid) {
        if (!sameAddr(str(e.agent_wallet), agent)) continue;
        const escrowId = str(e.escrow_id);
        const status = earnedByEscrow.has(escrowId)
            ? 'released'
            : refundedEscrows.has(escrowId)
              ? 'refunded'
              : 'pending';
        jobs.push({
            jobId: str(e.job_id),
            escrowId,
            cost: num(e.cost),
            earned: earnedByEscrow.get(escrowId) ?? 0,
            paidAtMs: num(e.paid_at_ms),
            status,
        });
    }
    return jobs.sort((a, b) => b.paidAtMs - a.paidAtMs);
}
