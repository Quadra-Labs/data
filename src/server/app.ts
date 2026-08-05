/**
 * app.ts — the read gateway.
 *
 * The Sui original was a WRITE gateway: it held the only key, and engines POSTed scores, schedules
 * and templates through it behind role tokens. None of that survives. On Flare every writer holds
 * its own key and writes on chain, so this serves reads and exactly one signed write (an agent
 * publishing where it can be reached).
 *
 * Every read has two paths — the index when it is fresh, the chain when it is not — so the gateway
 * works before the indexer has ever run.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Address, Hex, PublicClient } from 'viem';
import { fetchGroundTruth } from 'quadra-core/ground-truth';

import type { DataConfig } from '../config.js';
import { makePassportReader, categoryOf } from '../chain/passport.js';
import { makeCompetitionReader } from '../chain/competitions.js';
import { makeTeeRegistryReader } from '../chain/teeRegistry.js';
import { jobEscrowAbi, passportAbi } from '../chain/abis.js';
import { getLogsChunked, isTransient } from 'quadra-core';
import { decodeFunctionData } from 'viem';
import { loadCatalog, deployedAgents, type CatalogAgent } from '../agents/catalog.js';
import { Cached, KeyedCache } from '../cache.js';
import { makeReadLayer, type ReadLayer } from './readLayer.js';
import { serialize } from './json.js';
import { verifyAgentSignature, isPublishableUrl } from './auth.js';
import { IndexDb } from '../indexer/db.js';

export interface AppOptions {
    readonly config: DataConfig;
    readonly client: PublicClient;
    /** Injected so tests can supply an in-memory database instead of a file. */
    readonly readLayer?: ReadLayer | undefined;
}

interface RawBodyRequest extends FastifyRequest {
    rawBody?: string;
}

const bad = (reply: FastifyReply, code: number, error: string, detail?: string): FastifyReply =>
    reply.code(code).send(detail === undefined ? { error } : { error, detail });

export function buildApp(opts: AppOptions): FastifyInstance {
    const cfg = opts.config;
    const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });

    const readLayer =
        opts.readLayer ??
        makeReadLayer({
            dbPath: cfg.indexerDbPath,
            client: opts.client,
            maxLagBlocks: cfg.maxLagBlocks,
        });

    const passport = makePassportReader(opts.client, cfg.passport);
    const competitions = makeCompetitionReader(opts.client, cfg.sealedCompetition);
    const tee = makeTeeRegistryReader(opts.client, cfg.teeRegistry, cfg.readCacheTtlMs);

    const catalog = loadCatalog();
    const catalogByWallet = new Map<string, CatalogAgent>(
        deployedAgents(catalog).map((a) => [a.wallet!.toLowerCase(), a]),
    );
    const allowedAgents = new Set(catalogByWallet.keys());

    // Live-path caches. Coalescing is what stops ten concurrent readers becoming ten identical
    // walks of a rate-limited endpoint.
    const leaderboards = new KeyedCache<unknown>(
        (evaluatorId) => passport.leaderboard(evaluatorId),
        { ttlMs: cfg.readCacheTtlMs },
    );
    const recentCompetitions = new Cached(() => competitions.recent(6_000n), {
        ttlMs: cfg.readCacheTtlMs,
    });
    /**
     * Authorized recorders this gateway is not indexing.
     *
     * Cached for a long time and deliberately so: it is a full-history log scan, and calling it
     * per request made `/health` cost ~300 RPC calls. That tripped the endpoint's rate limit,
     * which made the freshness probe fail, which dropped every route to live chain reads, which
     * issued more requests still. A health check must never be able to start that.
     */
    const unwatched = new Cached(() => unwatchedRecorders(opts.client, cfg), {
        ttlMs: 10 * 60_000,
    });

    // A finalized voting round never changes its answer, so this is perfectly cacheable.
    const groundTruth = new KeyedCache<unknown>(async (key) => {
        const [feedId, round] = key.split('@');
        const g = await fetchGroundTruth({
            daBaseUrl: cfg.daBaseUrl,
            feedId: feedId as Hex,
            votingRoundId: Number(round),
            apiKey: cfg.daApiKey,
        });
        return { value: g.value, feed: g.feed, groundTruth: g.groundTruth };
    }, { ttlMs: 10 * 60_000 });

    // --- serialization ---------------------------------------------------------------------------
    // Every money field is a bigint; Fastify's default serializer throws on those rather than
    // rounding them, which is correct and means the conversion has to be explicit.
    app.setSerializerCompiler(() => (data) => serialize(data));
    app.setReplySerializer((payload) => serialize(payload));

    // Capture the exact bytes before parsing: a signature covers what was SENT, and re-serializing
    // parsed JSON produces different bytes that would never verify.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
        (req as RawBodyRequest).rawBody = body as string;
        try {
            done(null, body === '' ? {} : JSON.parse(body as string));
        } catch (err) {
            done(err as Error, undefined);
        }
    });

    // --- CORS ------------------------------------------------------------------------------------
    app.addHook('onSend', async (_req, reply) => {
        reply.header('access-control-allow-origin', cfg.corsOrigin);
        reply.header('access-control-allow-headers', 'content-type, x-agent-ts, x-agent-sig');
        reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
        // Without Vary, a cache can serve one origin's allow-origin header to another.
        reply.header('vary', 'Origin');
    });
    app.options('/*', async (_req, reply) => reply.code(204).send());

    void app.register(rateLimit, {
        max: 240,
        timeWindow: '1 minute',
        // These are unauthenticated, browser-facing, and each is a multi-statement SQLite query or
        // a windowed chain walk.
        allowList: () => false,
    });

    // --- helpers ---------------------------------------------------------------------------------

    /** The index if it is fresh, else undefined — every read decides for itself what to do then. */
    const idx = (): Promise<IndexDb | undefined> => readLayer.index();

    const resolveCategory = (value: string | undefined): string => {
        if (!value) return '';
        return value.startsWith('0x') ? value : categoryOf(value);
    };

    // --- health ----------------------------------------------------------------------------------

    /**
     * Three states, because two would force a wrong answer on boot.
     *
     *   ok        the index is current
     *   warming   it exists but has never caught up — a first run, walking history
     *   degraded  it HAD caught up and has fallen behind
     *
     * All three still serve correct answers, because a cold or stale index falls back to live
     * chain reads. So `/health` stays 200 throughout: the service is up. `/ready` is where the
     * 503 lives, which is the liveness-versus-readiness split a load balancer expects — reporting
     * a booting gateway as unhealthy would stop traffic reaching something that works fine.
     */
    async function status(): Promise<{
        state: 'ok' | 'warming' | 'degraded';
        warnings: string[];
        body: Record<string, unknown>;
    }> {
        const health = await readLayer.health();
        const identity = await tee.identity();
        const strayRecorders = await unwatched.get().catch(() => [] as string[]);

        const warnings: string[] = [];
        if (!identity.registered) {
            warnings.push('no TEE is registered; nothing can settle yet');
        }
        if (identity.imageDigest === 'sha256:dev') {
            warnings.push('the TEE image digest is still the placeholder sha256:dev');
        }
        if (strayRecorders.length > 0) {
            warnings.push(
                `authorized recorders not being indexed: ${strayRecorders.join(', ')} — restart with them configured`,
            );
        }

        const state =
            health.fresh ? 'ok' : health.cursor === undefined ? 'warming' : 'degraded';
        return {
            state,
            warnings,
            body: {
                status: state,
                chainId: cfg.chainId,
                head: health.head,
                cursor: health.cursor,
                lagBlocks: health.lagBlocks,
                index: health.reason,
                agents: health.agents,
                jobs: health.jobs,
                tee: {
                    registered: identity.registered,
                    wallet: identity.wallet,
                    imageDigest: identity.imageDigest,
                    fccMode: identity.fccMode,
                },
                warnings,
            },
        };
    }

    /** Liveness. Always 200 while the process can answer — the fallback path is always correct. */
    app.get('/health', async (_req, reply) => {
        const s = await status();
        return reply.code(200).send({ ok: true, ...s.body });
    });

    /** Readiness. 503 until the index is current, so a stale gateway is visibly stale. */
    app.get('/ready', async (_req, reply) => {
        const s = await status();
        return reply.code(s.state === 'ok' ? 200 : 503).send({ ok: s.state === 'ok', ...s.body });
    });

    // --- agents ----------------------------------------------------------------------------------

    app.get('/agents', async (req, reply) => {
        const q = req.query as { owner?: string };
        const db = await idx();
        if (db) return reply.send({ agents: withCatalog(db.listAgents(q.owner), catalogByWallet) });
        return reply.send({ agents: catalogRows(catalog) });
    });

    app.get('/agents/query', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const db = await idx();
        if (!db) {
            // No index: fall back to the live leaderboard for the requested category.
            const evaluatorId = q['category'] ?? catalog[0]?.evaluatorId ?? 'price-range-guess';
            const rows = (await leaderboards.get(evaluatorId)) as { agent: string }[];
            return reply.send({
                rows: rows.map((r, i) => ({
                    ...catalogFor(catalogByWallet, r.agent),
                    ...r,
                    wallet: r.agent,
                    rank: i + 1,
                })),
                total: rows.length,
                page: 0,
                pageSize: rows.length,
                live: true,
            });
        }
        const page = db.queryAgents({
            search: q['search'],
            category: resolveCategory(q['category']),
            minJobs: q['minJobs'] ? Number(q['minJobs']) : undefined,
            sort: q['sort'] as 'overall' | 'score' | 'jobs' | 'name' | undefined,
            dir: q['dir'] === 'asc' ? 'asc' : 'desc',
            page: q['page'] ? Number(q['page']) : undefined,
            pageSize: q['pageSize'] ? Number(q['pageSize']) : undefined,
        });
        return reply.send({ ...page, rows: withCatalog(page.rows, catalogByWallet) });
    });

    app.get('/agents/:wallet', async (req, reply) => {
        const { wallet } = req.params as { wallet: string };
        const q = req.query as { category?: string };
        const db = await idx();
        const detail = db?.getAgentDetail(wallet, resolveCategory(q.category));
        if (detail) return reply.send(withCatalogOne(detail, catalogByWallet));

        // No index, or an agent it has never seen: read the track straight from the contract.
        const entry = catalogByWallet.get(wallet.toLowerCase());
        const evaluatorId = q.category ?? entry?.evaluatorId ?? 'price-range-guess';
        const track = await passport.track(wallet as Address, evaluatorId);
        return reply.send({ ...(entry ? catalogFields(entry) : {}), ...track, wallet, live: true });
    });

    app.get('/agents/:wallet/jobs', async (req, reply) => {
        const { wallet } = req.params as { wallet: string };
        const q = req.query as Record<string, string | undefined>;
        const db = await idx();
        if (!db) return reply.send({ jobs: [], total: 0, live: true, note: 'index unavailable' });
        return reply.send(
            db.listAgentJobs(wallet, {
                status: q['status'],
                page: q['page'] ? Number(q['page']) : undefined,
                pageSize: q['pageSize'] ? Number(q['pageSize']) : undefined,
            }),
        );
    });

    app.get('/passport/:agent/:evaluatorId', async (req, reply) => {
        const { agent, evaluatorId } = req.params as { agent: string; evaluatorId: string };
        // Always from the contract: this endpoint exists precisely to answer "what does the chain
        // say", so serving it from the index would defeat the point.
        return reply.send(await passport.track(agent as Address, evaluatorId));
    });

    // --- jobs ------------------------------------------------------------------------------------

    app.get('/users/:user/jobs', async (req, reply) => {
        const { user } = req.params as { user: string };
        const q = req.query as Record<string, string | undefined>;
        const db = await idx();
        if (!db) return reply.send({ jobs: [], total: 0, live: true, note: 'index unavailable' });
        return reply.send(
            db.listUserJobs(user, {
                status: q['status'],
                page: q['page'] ? Number(q['page']) : undefined,
                pageSize: q['pageSize'] ? Number(q['pageSize']) : undefined,
            }),
        );
    });

    app.get('/jobs/recent', async (req, reply) => {
        const q = req.query as { limit?: string };
        const db = await idx();
        return reply.send({ jobs: db ? db.recentJobs(q.limit ? Number(q.limit) : undefined) : [] });
    });

    app.get('/jobs/due', async (req, reply) => {
        const q = req.query as { at?: string };
        const db = await idx();
        const at = q.at ? Number(q.at) : Math.floor(Date.now() / 1000);
        // The keeper's alternative is a lookback log scan, where a job that fell outside the
        // window is never scored and nothing says so. This is the correctness fix, not a cache.
        return reply.send({ jobs: db ? db.dueJobs(at) : [], at });
    });

    app.get('/jobs/:jobId', async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        const db = await idx();
        const job = db?.getJob(jobId);
        if (!job) return bad(reply, 404, 'no_job', 'unknown job, or the index has not seen it yet');
        return reply.send(job);
    });

    /**
     * The delivered ciphertext, recovered from the `deliver` transaction's calldata.
     *
     * The 404 branch is kept from the Sui gateway. Its 410 `result_expired` branch is gone with
     * Walrus: calldata does not expire, so that whole failure mode no longer exists.
     *
     * This is a convenience. `quadra-verify` recovers the same bytes itself and must never call
     * this — see KNOWN-CONSTRAINTS entry 3.
     */
    app.get('/jobs/:jobId/ciphertext', async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        const db = await idx();
        const job = db?.getJob(jobId);

        let txHash = job?.deliveredTx;
        if (!txHash) {
            const logs = await getLogsChunked({
                client: opts.client,
                fromBlock: cfg.fromBlock,
                stopAtFirstHit: true,
                fetch: (from, to) =>
                    opts.client.getContractEvents({
                        address: cfg.jobEscrow,
                        abi: jobEscrowAbi,
                        eventName: 'Delivered',
                        args: { jobId: jobId as Hex },
                        fromBlock: from,
                        toBlock: to,
                    }),
            });
            txHash = logs.at(-1)?.transactionHash;
        }
        if (!txHash) {
            return bad(reply, 404, 'no_result', 'nothing has been delivered for this job');
        }

        const tx = await opts.client.getTransaction({ hash: txHash as Hex });
        const decoded = decodeFunctionData({ abi: jobEscrowAbi, data: tx.input });
        if (decoded.functionName !== 'deliver') {
            return bad(reply, 404, 'no_result', 'the delivery transaction is not a deliver call');
        }
        return reply.send({ jobId, ciphertext: decoded.args[1], txHash });
    });

    app.get('/delayed-failed', async (req, reply) => {
        const q = req.query as { limit?: string };
        const db = await idx();
        return reply.send({
            failures: db ? db.listFailures(q.limit ? Number(q.limit) : undefined) : [],
        });
    });

    app.get('/stats/activity', async (req, reply) => {
        const q = req.query as { days?: string };
        const db = await idx();
        return reply.send({ days: db ? db.activitySeries(q.days ? Number(q.days) : undefined) : [] });
    });

    // --- competitions ----------------------------------------------------------------------------

    app.get('/competitions', async (_req, reply) => {
        const db = await idx();
        if (db) return reply.send({ competitions: db.listCompetitions() });
        return reply.send({ competitions: await recentCompetitions.get(), live: true });
    });

    app.get('/competitions/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const db = await idx();
        const indexed = db?.getCompetition(id);
        if (indexed) {
            return reply.send({
                ...indexed,
                submissions: db?.listSubmissions(id) ?? [],
                prizes: db?.listPrizes(id) ?? [],
            });
        }
        const live = await competitions.get(id as Hex);
        if (!live) return bad(reply, 404, 'no_competition');
        return reply.send({ ...live, live: true });
    });

    // --- oracle mirror ---------------------------------------------------------------------------

    /**
     * A cached mirror of Flare's DA layer, for the UI only.
     *
     * The enclave and `quadra-verify` must NEVER read this. If the enclave took its price from an
     * operator-run endpoint, the operator could forge a settlement — which is precisely the trust
     * this system is built to remove.
     */
    app.get('/ground-truth', async (req, reply) => {
        const q = req.query as { feed?: string; round?: string };
        if (!q.feed || !q.round) return bad(reply, 400, 'bad_request', 'feed and round are required');
        try {
            const value = await groundTruth.get(`${q.feed}@${q.round}`);
            return reply.send({
                ...(value as object),
                note: 'convenience mirror for display only; verification must read the DA layer directly',
            });
        } catch (err) {
            return bad(reply, 502, 'da_unreachable', err instanceof Error ? err.message : 'unknown');
        }
    });

    // --- the one write ---------------------------------------------------------------------------

    app.post('/agent-endpoints', async (req, reply) => {
        const db = await idx();
        if (!db) return bad(reply, 503, 'no_index', 'the index is unavailable; try again shortly');

        const result = await verifyAgentSignature({
            headers: {
                ts: req.headers['x-agent-ts'] as string | undefined,
                sig: req.headers['x-agent-sig'] as string | undefined,
            },
            rawBody: (req as RawBodyRequest).rawBody ?? '',
            allowed: allowedAgents,
        });
        if (!result.ok) return bad(reply, 401, result.reason);

        const body = req.body as { url?: unknown };
        if (!isPublishableUrl(body.url)) {
            return bad(reply, 400, 'bad_url', 'url must be http(s) and under 512 characters');
        }
        // The write goes through a read-only handle in the split deployment, so this is only
        // available when the gateway owns the database.
        try {
            db.putEndpoint({ wallet: result.agent, url: body.url, updatedAt: Date.now() });
        } catch {
            return bad(reply, 503, 'read_only', 'this gateway cannot write; run it with the indexer');
        }
        return reply.send({ ok: true, wallet: result.agent, url: body.url });
    });

    app.get('/agent-endpoints/:wallet', async (req, reply) => {
        const { wallet } = req.params as { wallet: string };
        const db = await idx();
        const found = db?.getEndpoint(wallet);
        if (!found) return bad(reply, 404, 'no_endpoint');
        return reply.send(found);
    });

    /**
     * Never let a chain error reach a client verbatim.
     *
     * A rate-limited live read otherwise surfaced as a raw viem message with the RPC's own 429
     * status, which tells a caller to back off from US when the throttling is upstream, and leaks
     * the endpoint URL. A live path that cannot answer is a 503 from this service.
     */
    app.setErrorHandler((err: unknown, _req, reply) => {
        const message = err instanceof Error ? err.message : String(err);
        if (isTransient(message)) {
            app.log.warn(`upstream unavailable: ${message}`);
            return reply.code(503).send({
                error: 'upstream_unavailable',
                detail: 'the chain endpoint is rate-limiting or unreachable; retry shortly',
            });
        }
        app.log.error(message);
        const status = (err as { statusCode?: number }).statusCode;
        return reply.code(typeof status === 'number' ? status : 500).send({ error: 'internal_error' });
    });

    app.addHook('onClose', async () => readLayer.close());
    return app;
}

// --- catalog joining ------------------------------------------------------------------------------

const catalogFields = (a: CatalogAgent) => ({
    slug: a.slug,
    name: a.name,
    description: a.description,
    evaluatorId: a.evaluatorId,
    asset: a.asset,
    priceWei: a.priceWei,
    scoreless: a.scoreless,
});

function catalogFor(
    byWallet: ReadonlyMap<string, CatalogAgent>,
    wallet: string,
): Record<string, unknown> {
    const found = byWallet.get(wallet.toLowerCase());
    return found ? catalogFields(found) : {};
}

/** Identity from the catalog, everything scored from the chain. */
function withCatalog<T extends { wallet: string }>(
    rows: readonly T[],
    byWallet: ReadonlyMap<string, CatalogAgent>,
): unknown[] {
    return rows.map((r) => ({ ...catalogFor(byWallet, r.wallet), ...r }));
}

function withCatalogOne<T extends { wallet: string }>(
    row: T,
    byWallet: ReadonlyMap<string, CatalogAgent>,
): unknown {
    return { ...catalogFor(byWallet, row.wallet), ...row };
}

/** The catalog as agent rows, for a gateway with no index at all. */
function catalogRows(catalog: readonly CatalogAgent[]): unknown[] {
    return deployedAgents(catalog).map((a) => ({
        ...catalogFields(a),
        wallet: a.wallet,
        category: a.category,
        score: 0,
        jobs: 0,
        best: 0,
        createdAt: 0,
        live: true,
    }));
}

/**
 * Recorders authorized on the Passport that this gateway is not indexing.
 *
 * A second market contract would write reputation the index captures (the event comes from the
 * Passport itself) while its OWN jobs and competitions went unrecorded. It cannot happen by
 * accident, but it used to happen silently.
 */
async function unwatchedRecorders(client: PublicClient, cfg: DataConfig): Promise<string[]> {
    try {
        const logs = await getLogsChunked({
            client,
            fromBlock: cfg.fromBlock,
            fetch: (from, to) =>
                client.getContractEvents({
                    address: cfg.passport,
                    abi: passportAbi,
                    eventName: 'RecorderSet',
                    fromBlock: from,
                    toBlock: to,
                }),
        });
        const watched = new Set(
            [cfg.jobEscrow, cfg.sealedCompetition].map((a) => a.toLowerCase()),
        );
        const active = new Map<string, boolean>();
        for (const l of logs) {
            const recorder = l.args.recorder;
            if (recorder) active.set(recorder.toLowerCase(), l.args.allowed === true);
        }
        return [...active.entries()]
            .filter(([addr, allowed]) => allowed && !watched.has(addr))
            .map(([addr]) => addr);
    } catch {
        // Health must never fail because a scan did.
        return [];
    }
}
