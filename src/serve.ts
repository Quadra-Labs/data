/**
 * serve.ts — the gateway process.
 *
 * Runs the read API and, by default, the indexer alongside it in the SAME process.
 *
 * The Sui deployment split them, and its README explained why at length: a long-lived gRPC
 * checkpoint stream could not survive in a process that also performed multi-second Walrus blob
 * writes. Both halves of that reason are gone — there is no stream and there are no Walrus writes
 * — so the split now costs a second process, a second config, and a shared SQLite file for
 * nothing. Set `INDEXER=0` to run them apart anyway; the file-sharing rules are unchanged.
 */

import './boot.js';

import { pathToFileURL } from 'node:url';

import { loadConfig, explainMissing } from './config.js';
import { makeClient } from './chain/client.js';
import { buildApp } from './server/app.js';
import { IndexDb } from './indexer/db.js';
import { routeLogs } from './indexer/router.js';
import { startTailer, type TailerHandle } from './indexer/tailer.js';
import { findEarliestDeployBlock } from './indexer/deployBlock.js';
import { preflight, reportPreflight } from './indexer/preflight.js';
import { makeEventBus } from './server/events.js';

export async function main(): Promise<void> {
    const loaded = loadConfig();
    if (!loaded.ok) {
        console.error(explainMissing(loaded.missing, Number(process.env['CHAIN_ID'] ?? 114)));
        process.exitCode = 1;
        return;
    }
    const cfg = loaded.config;
    const client = makeClient(cfg);
    const runsIndexer = (process.env['INDEXER'] ?? '1') !== '0';
    // Only offer the push feed when this process is the one producing events.
    const events = runsIndexer ? makeEventBus() : undefined;
    const app = buildApp({ config: cfg, client, events });

    // --- the indexer, in-process by default ------------------------------------------------------
    let db: IndexDb | undefined;
    let tailer: TailerHandle | undefined;

    if (runsIndexer) {
        // Same refusal as the standalone indexer, for the same reason: this process WRITES the
        // index, and one built against a deployment whose constants disagree with this build is
        // wrong in a way no later check catches. A gateway that only served reads would skip this.
        const checks = await preflight(client, {
            jobEscrow: cfg.jobEscrow,
            sealedCompetition: cfg.sealedCompetition,
        });
        const proceed = reportPreflight(checks, {
            warn: (line) => app.log.warn(line),
            error: (line) => app.log.error(line),
        });
        if (!proceed) {
            process.exitCode = 1;
            return;
        }

        db = new IndexDb(cfg.indexerDbPath);
        const targets = {
            jobEscrow: cfg.jobEscrow,
            sealedCompetition: cfg.sealedCompetition,
            passport: cfg.passport,
        };
        const addresses = [cfg.jobEscrow, cfg.sealedCompetition, cfg.passport, cfg.teeRegistry];

        let fromBlock = cfg.fromBlock;
        if (fromBlock === 0n) {
            const cached = db.getMeta('deploy_block');
            if (cached !== undefined) fromBlock = BigInt(cached);
            else {
                const found = await findEarliestDeployBlock({ client, addresses });
                if (found !== undefined) {
                    db.setMeta('deploy_block', found.toString());
                    fromBlock = found;
                }
            }
        }
        app.log.info(`indexing from block ${fromBlock}`);

        const owned = db;
        tailer = startTailer({
            client,
            addresses,
            fromBlock,
            chunk: cfg.logChunkBlocks,
            passSpanBlocks: cfg.passSpanBlocks,
            confirmations: cfg.confirmations,
            pollMs: cfg.pollMs,
            ...(db.getCursor() ? { startCursor: db.getCursor() } : {}),
            cachedBlockTs: (n) => owned.getBlockTs(n),
            rememberBlock: (n, ts, hash) => owned.putBlock(n, ts, hash),
            onLogs: (logs) => {
                const stats = owned.batch(() => routeLogs(owned, targets, logs));
                if (stats.applied > 0) app.log.info(`indexed ${stats.applied} events`);
                if (stats.undecodable > 0) {
                    app.log.warn(`${stats.undecodable} logs did not decode; check the ABIs`);
                }
                // Published AFTER the batch commits, so a subscriber can never be told about
                // something a reader cannot yet see.
                for (const e of stats.events) events?.publish(e);
            },
            onProgress: (cursor) => owned.setCursor(cursor),
            onReorg: (rewound) => {
                app.log.warn(`reorg: rolling back above block ${rewound.blockNumber}`);
                // One transaction, same reasoning as the standalone indexer: a committed delete
                // with an unmoved cursor loses those blocks permanently on the next restart.
                owned.batch(() => {
                    owned.rollbackAbove(rewound.blockNumber);
                    owned.setCursor(rewound);
                });
            },
            onError: (message, expected) => {
                if (expected) app.log.warn(`indexer transient: ${message}`);
                else app.log.error(`indexer: ${message}`);
            },
        });
    }

    // --- shutdown --------------------------------------------------------------------------------
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        app.log.info(`${signal} received, shutting down`);
        tailer?.stop();
        await tailer?.done;
        await app.close();
        // Closed last: the read layer holds its own handle and releases it on app close.
        db?.close();
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await app.listen({ port: cfg.port, host: '0.0.0.0' });
    app.log.info(`quadra-data listening on ${cfg.port} (chain ${cfg.chainId})`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    main().catch((err: unknown) => {
        console.error(err instanceof Error ? err.stack : String(err));
        process.exitCode = 1;
    });
}
