/**
 * Off-chain indexer: keeps a SQLite mirror of the agent registry, scores, and jobs
 * so the gateway can serve fast reads. Cold start seeds from the registry + scores
 * doc + historical events; then it tails the checkpoint stream forward (native gRPC
 * HTTP/2), routing agent/intake/job-access/pointer events into the DB. On-chain
 * writes are untouched.
 *
 * Run from data/:  npm run indexer
 */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

import { DataLayer } from '../index.js';
import { IndexDb } from './db.js';
import { CheckpointTailer } from './tailer.js';

type EventId = { txDigest: string; eventSeq: string };

const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));

function main(): void {
    try {
        process.loadEnvFile('.env');
    } catch {
        // No .env file — rely on the ambient environment.
    }

    const dl = DataLayer.forReads();
    const dbPath = process.env.INDEXER_DB_PATH ?? 'quadra-index.db';
    const db = new IndexDb(dbPath);

    const url = process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(dl.config.network);
    const sui = new SuiJsonRpcClient({ network: dl.config.network, url });

    const pkg = dl.config.quadraPackageId;
    const types = {
        agentRegistered: `${pkg}::agent::AgentRegistered`,
        jobPaid: `${pkg}::intake::JobPaid`,
        released: `${pkg}::intake::PaymentReleased`,
        refunded: `${pkg}::intake::JobNotDelivered`,
        accessRecorded: `${pkg}::job_access::AccessRecorded`,
        pointerUpdated: `${dl.config.walrusJsonPackageId}::pointer::PointerUpdated`,
    };
    const scoresPointerId = dl.config.pointers.agent_scores;

    async function handleEvent(eventType: string, json: Record<string, unknown>): Promise<void> {
        switch (eventType) {
            case types.jobPaid:
                db.applyJobPaid({
                    escrowId: str(json.escrow_id),
                    jobId: str(json.job_id),
                    agent: str(json.agent_wallet),
                    cost: num(json.cost),
                    paidAtMs: num(json.paid_at_ms),
                });
                break;
            case types.released:
                db.applyReleased({
                    escrowId: str(json.escrow_id),
                    agent: str(json.agent_wallet),
                    earned: num(json.agent_amount),
                    fee: num(json.fee),
                });
                break;
            case types.refunded:
                db.applyRefunded({
                    escrowId: str(json.escrow_id),
                    jobId: str(json.job_id),
                    agent: str(json.agent_wallet),
                });
                break;
            case types.accessRecorded:
                db.setJobUser(str(json.job_id), str(json.user));
                break;
            case types.agentRegistered: {
                const wallet = str(json.agent_id);
                // The event omits the description, so fetch the full AgentInfo once. Prefer the
                // on-chain scoreless flag from it; fall back to the event field.
                let description = '';
                let scoreless = json.scoreless === true;
                try {
                    const info = await dl.agents.get(wallet);
                    if (info) {
                        description = info.description;
                        scoreless = info.scoreless;
                    }
                } catch {
                    // Keep the event fields; description fills in on the next reconcile.
                }
                db.upsertAgentIdentity({
                    wallet,
                    owner: str(json.owner),
                    name: str(json.name),
                    category: str(json.category),
                    description,
                    scoreless,
                });
                break;
            }
            case types.pointerUpdated:
                if (str(json.pointer_id) === scoresPointerId) {
                    db.applyScores(await dl.agentScores.read());
                }
                break;
        }
    }

    async function queryAll(type: string, onEach: (json: Record<string, unknown>) => Promise<void>): Promise<void> {
        let cursor: EventId | null | undefined;
        for (;;) {
            const page = await sui.queryEvents({
                query: { MoveEventType: type },
                cursor,
                limit: 50,
                order: 'ascending',
            });
            for (const event of page.data) {
                if (event.parsedJson) await onEach(event.parsedJson as Record<string, unknown>);
            }
            if (!page.hasNextPage) break;
            cursor = page.nextCursor as EventId | null | undefined;
        }
    }

    async function bootstrap(): Promise<void> {
        console.log('[indexer] cold start: seeding from chain...');
        const agents = await dl.agents.list();
        for (const a of agents) {
            db.upsertAgentIdentity({
                wallet: a.wallet,
                owner: a.owner,
                name: a.name,
                description: a.description,
                category: a.category,
                scoreless: a.scoreless,
            });
        }
        console.log(`[indexer] seeded ${agents.length} agents`);

        try {
            db.applyScores(await dl.agentScores.read());
        } catch (err) {
            console.warn('[indexer] scores seed skipped:', err instanceof Error ? err.message : err);
        }

        // Order matters: a job must be paid before it can be released/refunded.
        await queryAll(types.jobPaid, (j) => handleEvent(types.jobPaid, j));
        await queryAll(types.released, (j) => handleEvent(types.released, j));
        await queryAll(types.refunded, (j) => handleEvent(types.refunded, j));
        await queryAll(types.accessRecorded, (j) => handleEvent(types.accessRecorded, j));
        console.log('[indexer] seeded historical jobs');

        const latest = Number(await sui.getLatestCheckpointSequenceNumber());
        db.setCursor(latest);
        console.log(`[indexer] bootstrap complete at checkpoint ${latest}`);
    }

    void (async () => {
        if (db.getCursor() === undefined) {
            await bootstrap();
        } else {
            console.log(`[indexer] resuming from checkpoint ${db.getCursor()}`);
        }

        // Serialize async handlers so events apply in stream order.
        let chain: Promise<void> = Promise.resolve();
        const enqueue = (task: () => Promise<void>) => {
            chain = chain.then(task).catch((err) =>
                console.error('[indexer] event error:', err instanceof Error ? err.message : err),
            );
        };

        let latestSeq = db.getCursor() ?? 0;
        const tailer = new CheckpointTailer({
            network: dl.config.network,
            ...(dl.config.grpcUrl ? { url: dl.config.grpcUrl } : {}),
            eventTypes: Object.values(types),
            onEvent: (e) => enqueue(() => handleEvent(e.eventType, e.json)),
            onCheckpoint: (seq) => {
                latestSeq = seq;
            },
            reconnectMs: dl.config.watchReconnectMs,
            fromCheckpoint: latestSeq,
        });
        tailer.start();
        console.log(`[indexer] tailing ${dl.config.network} via gRPC ${tailer.host} from checkpoint ${latestSeq}`);

        // Persist the cursor periodically (a few seconds stale is fine; the tailer
        // backfills the small gap on restart and upserts are idempotent).
        const heartbeat = setInterval(() => {
            try {
                db.setCursor(latestSeq);
            } catch {
                // best effort
            }
        }, 5000);

        const shutdown = () => {
            clearInterval(heartbeat);
            tailer.stop();
            try {
                db.setCursor(latestSeq);
                db.close();
            } catch {
                // best effort
            }
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    })().catch((err) => {
        console.error('[indexer] fatal:', err);
        process.exit(1);
    });
}

main();
