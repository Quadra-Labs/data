/**
 * Data layer write GATEWAY (Fastify). The sole holder of `DATA_SECRET_KEY` and
 * the only on-chain writer. Engines write through this API with a per-engine role
 * token (`x-quadra-role`); agents write with a signed message. The gateway
 * enforces which role/identity may write which database. Reads are open.
 *
 * Watching is a SEPARATE service (`watch-server.ts`): the gRPC stream can't share
 * a process with Walrus writes.
 */
import Fastify from 'fastify';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

import { DataLayer } from './index.js';
import { loadGatewayAuth, type Role } from './config.js';
import { requireAgent, requireRole } from './auth.js';
import { IndexDb, openReadonly, type AgentsQuery } from './indexer/db.js';
import { liveAgentDetail, liveAgentJobs, liveAgentRows, rankAndPage } from './indexer/live.js';
import type { FailedJob, EvalEngineEntry, JobStart, JobTemplate, SealedResultBlob } from './types.js';

function parseAgentsQuery(query: Record<string, unknown>): AgentsQuery {
    const q = query as Record<string, string | undefined>;
    return {
        ...(q.search ? { search: q.search } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.minJobs ? { minJobs: Number(q.minJobs) } : {}),
        ...(q.sort ? { sort: q.sort as AgentsQuery['sort'] } : {}),
        ...(q.dir === 'asc' || q.dir === 'desc' ? { dir: q.dir } : {}),
        ...(q.page ? { page: Number(q.page) } : {}),
        ...(q.pageSize ? { pageSize: Number(q.pageSize) } : {}),
    };
}

function startServer(): void {
    try {
        process.loadEnvFile('.env');
    } catch {
        // No .env file — rely on the ambient environment.
    }

    const dl = DataLayer.fromEnv();
    const auth = loadGatewayAuth();
    const app = Fastify({ logger: true });

    // Off-chain index (written by `npm run indexer`). Opened read-only and lazily so
    // the gateway picks it up once it appears; falls back to live reads if absent/empty.
    const indexPath = process.env.INDEXER_DB_PATH ?? 'quadra-index.db';
    let index: IndexDb | null = null;
    const useIndex = (): IndexDb | null => {
        if (!index) index = openReadonly(indexPath);
        try {
            if (index && index.agentCount() > 0) return index;
        } catch {
            // Corrupt/locked read; fall back to live.
        }
        return null;
    };
    const fallbackSui = new SuiJsonRpcClient({
        network: dl.config.network,
        url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(dl.config.network),
    });

    // Capture the raw body so agent signatures verify against the exact bytes.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        (_req as { rawBody?: string }).rawBody = body as string;
        try {
            done(null, (body as string).length ? JSON.parse(body as string) : {});
        } catch (error) {
            done(error as Error);
        }
    });

    // CORS: the web reads these endpoints directly from the browser. Reads are public, so a
    // permissive default origin is fine; tighten DATA_CORS_ORIGIN (e.g. https://quadra.sh) in
    // production. Agent-signed writes + role tokens travel in the x-quadra-* headers, so allow
    // them on preflight. A wildcard OPTIONS route answers the browser's preflight for any path.
    const corsOrigin = process.env.DATA_CORS_ORIGIN ?? '*';
    app.addHook('onSend', async (_req, reply, payload) => {
        reply.header('access-control-allow-origin', corsOrigin);
        reply.header('access-control-allow-headers', 'content-type, x-quadra-role, x-quadra-ts, x-quadra-sig');
        reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
        return payload;
    });
    app.options('/*', async (_req, reply) => reply.code(204).send());

    // `role()` with no args = admin-only.
    const role = (...roles: Role[]) => requireRole(auth, ...roles);

    app.get('/health', async () => ({ ok: true, network: dl.config.network }));

    // --- agent scores ------------------------------------------------------
    app.get('/agent-scores', async () => dl.agentScores.read());
    app.get('/agent-scores/:wallet', async (req) => {
        const { wallet } = req.params as { wallet: string };
        return (await dl.agentScores.get(wallet)) ?? null;
    });
    app.post('/agent-scores/record', { preHandler: role('scheduler') }, async (req) => {
        const { wallet, score } = req.body as { wallet: string; score: number };
        return dl.agentScores.recordJob(wallet, score);
    });

    // --- agent endpoints (self-published live URL; chat discovery) ----------
    app.get('/agent-endpoints/:wallet', async (req, reply) => {
        if (!dl.agentEndpoints) return reply.code(503).send({ error: 'agent endpoints not configured' });
        const { wallet } = req.params as { wallet: string };
        return (await dl.agentEndpoints.get(wallet)) ?? null;
    });
    // The agent self-publishes its own URL (signed); the recovered wallet is the key.
    app.post(
        '/agent-endpoints',
        { preHandler: requireAgent(dl, auth, { requireRegistered: true, allowAdmin: false }) },
        async (req, reply) => {
            if (!dl.agentEndpoints) return reply.code(503).send({ error: 'agent endpoints not configured' });
            const wallet = (req as { agentWallet?: string }).agentWallet!;
            const { url } = req.body as { url?: string };
            if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
                return reply.code(400).send({ error: 'url (http/https) is required' });
            }
            return dl.agentEndpoints.set(wallet, url);
        },
    );

    // --- agent identity + scores + jobs (served from the off-chain index) ---
    // Joined rows (identity + running score + jobs), optionally filtered by owner.
    app.get('/agents', async (req) => {
        const { owner } = req.query as { owner?: string };
        const idx = useIndex();
        return idx ? idx.listAgents(owner) : liveAgentRows(dl, owner);
    });

    // Server-side search/filter/sort/pagination with computed overall + rank.
    app.get('/agents/query', async (req) => {
        const q = parseAgentsQuery(req.query as Record<string, unknown>);
        const idx = useIndex();
        return idx ? idx.queryAgents(q) : rankAndPage(await liveAgentRows(dl), q);
    });

    app.get('/agents/:wallet', async (req) => {
        const { wallet } = req.params as { wallet: string };
        const idx = useIndex();
        return idx ? idx.getAgentDetail(wallet) : liveAgentDetail(dl, wallet);
    });

    app.get('/agents/:wallet/jobs', async (req) => {
        const { wallet } = req.params as { wallet: string };
        const { status, page, pageSize } = req.query as {
            status?: string;
            page?: string;
            pageSize?: string;
        };
        const idx = useIndex();
        if (idx) {
            return idx.listAgentJobs(wallet, {
                ...(status ? { status } : {}),
                page: page ? Number(page) : 0,
                pageSize: pageSize ? Number(pageSize) : 50,
            });
        }
        const all = await liveAgentJobs(fallbackSui, dl.config.quadraPackageId, wallet);
        const filtered = status ? all.filter((j) => j.status === status) : all;
        const p = page ? Number(page) : 0;
        const ps = pageSize ? Number(pageSize) : 50;
        return { jobs: filtered.slice(p * ps, p * ps + ps), total: filtered.length };
    });

    // --- network activity (dashboard) --------------------------------------
    // Recent deliveries across all agents + a daily activity series. Index-backed;
    // the live path has no jobs mirror, so it returns empty (run the indexer for these).
    app.get('/jobs/recent', async (req) => {
        const { limit } = req.query as { limit?: string };
        const idx = useIndex();
        return { jobs: idx ? idx.recentJobs(limit ? Number(limit) : 8) : [] };
    });
    app.get('/stats/activity', async (req) => {
        const { days } = req.query as { days?: string };
        const idx = useIndex();
        return { days: idx ? idx.activitySeries(days ? Number(days) : 14) : [] };
    });

    // --- delayed & failed jobs ---------------------------------------------
    app.get('/delayed-failed', async () => dl.delayedFailedJobs.list());
    app.post('/delayed-failed', { preHandler: role('scheduler') }, async (req) =>
        dl.delayedFailedJobs.add(req.body as Omit<FailedJob, 'at'>),
    );

    // --- job templates -----------------------------------------------------
    app.get('/templates', async () => dl.jobTemplates.list());
    app.get('/templates/:id', async (req) => {
        const { id } = req.params as { id: string };
        return (await dl.jobTemplates.get(id)) ?? null;
    });
    app.put('/templates', { preHandler: role() }, async (req) =>
        dl.jobTemplates.put(req.body as JobTemplate),
    );

    // --- eval engines (routing catalog) ------------------------------------
    app.get('/eval-engines', async () => dl.evalEngines.list());
    app.get('/eval-engines/:id', async (req) => {
        const { id } = req.params as { id: string };
        return (await dl.evalEngines.get(id)) ?? null;
    });
    app.put('/eval-engines/:id', { preHandler: role() }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = req.body as Partial<EvalEngineEntry>;
        if (typeof body.url !== 'string' || body.url.length === 0) {
            return reply.status(400).send({ error: 'url is required' });
        }
        return dl.evalEngines.put({
            evaluator_id: id,
            url: body.url,
            ...(typeof body.enclave_id === 'string' && body.enclave_id.length > 0
                ? { enclave_id: body.enclave_id }
                : {}),
        });
    });
    app.delete('/eval-engines/:id', { preHandler: role() }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const removed = await dl.evalEngines.remove(id);
        if (!removed) return reply.status(404).send({ error: 'not found' });
        return { ok: true };
    });

    // --- job scheduler -----------------------------------------------------
    app.get('/scheduler', async () => dl.jobScheduler.list());
    app.get('/scheduler/due', async () => dl.jobScheduler.due());
    app.put('/scheduler/:jobId', { preHandler: role('intake') }, async (req) => {
        const { jobId } = req.params as { jobId: string };
        const { expires_at, start } = req.body as { expires_at: number; start?: JobStart };
        await dl.jobScheduler.set(jobId, expires_at, start);
        return { ok: true };
    });
    app.delete('/scheduler/:jobId', { preHandler: role('scheduler') }, async (req) => {
        const { jobId } = req.params as { jobId: string };
        await dl.jobScheduler.remove(jobId);
        return { ok: true };
    });

    // --- job results (sealed envelope from the agent; gateway never decrypts) ---
    app.get('/job-results/:jobId', async (req) => {
        const { jobId } = req.params as { jobId: string };
        const sealed = await dl.jobResults.fetchSealed(jobId); // ciphertext envelope only
        // The validator fetches here before decrypting. Logging hit/miss pinpoints "agent never
        // registered the result" vs "stored but decrypt failed" when a paid job refunds.
        app.log.info(`[results] fetch ${jobId}: ${sealed ? 'found' : 'NOT FOUND'}`);
        return sealed;
    });
    app.post(
        '/job-results',
        { preHandler: requireAgent(dl, auth, { requireRegistered: true, allowAdmin: false }) },
        async (req) => {
            const body = req.body as SealedResultBlob;
            const out = await dl.jobResults.storeSealed(body);
            app.log.info(`[results] stored job ${body.job_id} -> blob ${out.blobId}`);
            return out;
        },
    );

    // Flush any pending writes and release resources, then exit. Registered for SIGINT/SIGTERM so
    // a restart does not strand un-flushed writes (they would still be recovered on next boot from
    // the durable store, but draining now keeps the on-chain lag minimal).
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        app.log.info(`${signal} received, flushing write-behind queue...`);
        try {
            if (dl.writeBehind) {
                await dl.writeBehind.worker.stop();
                dl.writeBehind.store.close();
            }
            await app.close();
        } catch (err) {
            app.log.warn(`shutdown error: ${err}`);
        } finally {
            process.exit(0);
        }
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    app.listen({ port: dl.config.port, host: '0.0.0.0' })
        .then((address) => {
            app.log.info(`Quadra data gateway listening on ${address}`);
            // Warm EVERY cached read doc so the first request for any of them is served from memory:
            // the slow Walrus resolves happen here, once, in the background — not on a user request.
            void dl
                .warmCaches()
                .then((r) => {
                    const ok = r.filter((x) => x.ok).map((x) => x.db);
                    const failed = r.filter((x) => !x.ok).map((x) => x.db);
                    app.log.info(`caches warmed: ${ok.join(', ') || 'none'}`);
                    if (failed.length > 0) app.log.warn(`cache warm-up failed for: ${failed.join(', ')}`);
                })
                .catch((err) => app.log.warn(`cache warm-up failed: ${err}`))
                .finally(() => {
                    // Start the background flush worker AFTER warm reconciles the store against
                    // chain, so it flushes the right baselines (and recovers a prior crash's queue).
                    if (dl.writeBehind) {
                        dl.writeBehind.worker.start();
                        app.log.info('write-behind ON: writes return instantly, flushed on-chain in the background');
                    } else {
                        app.log.info('write-behind OFF (WRITE_BEHIND=0): writes commit synchronously on-chain');
                    }
                });
        })
        .catch((error) => {
            app.log.error(error);
            process.exit(1);
        });
}

startServer();
