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

import { DataLayer } from './index.js';
import { loadGatewayAuth, type Role } from './config.js';
import { requireAgent, requireRole } from './auth.js';
import type { FailedJob, JobTemplate, SealedResultBlob } from './types.js';

function startServer(): void {
    try {
        process.loadEnvFile('.env');
    } catch {
        // No .env file — rely on the ambient environment.
    }

    const dl = DataLayer.fromEnv();
    const auth = loadGatewayAuth();
    const app = Fastify({ logger: true });

    // Capture the raw body so agent signatures verify against the exact bytes.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        (_req as { rawBody?: string }).rawBody = body as string;
        try {
            done(null, (body as string).length ? JSON.parse(body as string) : {});
        } catch (error) {
            done(error as Error);
        }
    });

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

    // --- agent identity (read-only; agents register on chain) --------------
    app.get('/agents', async () => dl.agents.list());
    app.get('/agents/:wallet', async (req) => {
        const { wallet } = req.params as { wallet: string };
        return (await dl.agents.get(wallet)) ?? null;
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

    // --- job scheduler -----------------------------------------------------
    app.get('/scheduler', async () => dl.jobScheduler.list());
    app.get('/scheduler/due', async () => dl.jobScheduler.due());
    app.put('/scheduler/:jobId', { preHandler: role('intake') }, async (req) => {
        const { jobId } = req.params as { jobId: string };
        const { expires_at } = req.body as { expires_at: number };
        await dl.jobScheduler.set(jobId, expires_at);
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
        return dl.jobResults.fetchSealed(jobId); // ciphertext envelope only
    });
    app.post(
        '/job-results',
        { preHandler: requireAgent(dl, auth, { requireRegistered: true, allowAdmin: false }) },
        async (req) => dl.jobResults.storeSealed(req.body as SealedResultBlob),
    );

    app.listen({ port: dl.config.port, host: '0.0.0.0' })
        .then((address) => app.log.info(`Quadra data gateway listening on ${address}`))
        .catch((error) => {
            app.log.error(error);
            process.exit(1);
        });
}

startServer();
