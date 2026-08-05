/**
 * indexer.ts — the process that keeps the index current.
 *
 * Cold start and live tail are the SAME code path, which the Sui version could not manage: there,
 * a cold start went through `queryEvents` over JSON-RPC while the live tail used a gRPC checkpoint
 * stream, so the two disagreed about ordering and only one of them had retry logic. Here both are
 * `runPass`, and catching up on a million blocks differs from catching up on ten only in how long
 * it takes.
 *
 * Run it with `pnpm indexer`. It is safe to stop and restart at any point: the cursor is durable,
 * every writer is idempotent, and a restart re-reads the cursor block to check the chain did not
 * move under it while the process was down.
 */

import '../boot.js';

import { pathToFileURL } from 'node:url';

import type { Address } from 'viem';

import { loadConfig, explainMissing } from '../config.js';
import { makeClient } from '../chain/client.js';
import { IndexDb } from './db.js';
import { findEarliestDeployBlock } from './deployBlock.js';
import { routeLogs, type RouteStats } from './router.js';
import { startTailer, type TailerCursor } from './tailer.js';

const log = (msg: string): void => console.log(`[indexer] ${msg}`);

/**
 * Where to start walking.
 *
 * An explicit `FROM_BLOCK` wins. Otherwise the deploy block is discovered once by binary search
 * and cached in the index, because the alternative — starting at genesis — is over a million
 * requests on Coston2 and simply never completes. The deployments file does not record it.
 */
async function resolveFloor(
    configured: bigint,
    db: IndexDb,
    client: ReturnType<typeof makeClient>,
    addresses: readonly Address[],
): Promise<bigint> {
    if (configured > 0n) return configured;

    const cached = db.getMeta('deploy_block');
    if (cached !== undefined) return BigInt(cached);

    log('no FROM_BLOCK set; finding the deploy block by binary search over eth_getCode...');
    const found = await findEarliestDeployBlock({
        client,
        addresses,
        onProbe: (address, block) => log(`  ${address} deployed at block ${block}`),
    });
    if (found === undefined) {
        log('WARNING: none of the configured addresses has code — check the deployment');
        return 0n;
    }
    db.setMeta('deploy_block', found.toString());
    log(`deploy block ${found}; starting there`);
    return found;
}

export async function main(): Promise<void> {
    const loaded = loadConfig();
    if (!loaded.ok) {
        console.error(explainMissing(loaded.missing, Number(process.env['CHAIN_ID'] ?? 114)));
        process.exitCode = 1;
        return;
    }
    const cfg = loaded.config;
    const db = new IndexDb(cfg.indexerDbPath);
    const client = makeClient(cfg);

    const targets = {
        jobEscrow: cfg.jobEscrow,
        sealedCompetition: cfg.sealedCompetition,
        passport: cfg.passport,
    };
    const addresses = [cfg.jobEscrow, cfg.sealedCompetition, cfg.passport, cfg.teeRegistry];

    const start = db.getCursor();
    const head = await client.getBlockNumber();

    log(`chain ${cfg.chainId} at ${cfg.rpcUrl}`);
    log(`index ${cfg.indexerDbPath} (${db.agentCount()} agents, ${db.jobCount()} jobs)`);

    const fromBlock = await resolveFloor(cfg.fromBlock, db, client, addresses);
    const behind = Number(head) - (start?.blockNumber ?? Number(fromBlock));
    log(
        start
            ? `resuming from block ${start.blockNumber}, ${behind} behind head ${head}`
            : `cold start from block ${fromBlock}, ${behind} blocks to walk`,
    );

    const totals: RouteStats = { applied: 0, ignored: 0, undecodable: 0, events: [] };
    let lastReport = 0;

    const tailer = startTailer({
        client,
        addresses,
        fromBlock,
        chunk: cfg.logChunkBlocks,
        confirmations: cfg.confirmations,
        pollMs: cfg.pollMs,
        ...(start ? { startCursor: start } : {}),

        cachedBlockTs: (n) => db.getBlockTs(n),
        rememberBlock: (n, ts, hash) => db.putBlock(n, ts, hash),

        onLogs: (logs) => {
            // One transaction for the whole batch: the tailer retries the identical range if this
            // throws, so a half-applied pass must leave nothing behind.
            const stats = db.batch(() => routeLogs(db, targets, logs));
            totals.applied += stats.applied;
            totals.ignored += stats.ignored;
            totals.undecodable += stats.undecodable;
            if (stats.applied > 0) {
                log(
                    `applied ${stats.applied} events (${logs.at(0)?.blockNumber}..${logs.at(-1)?.blockNumber})`,
                );
            }
            if (stats.undecodable > 0) {
                // Not fatal — but a rising count means an ABI has drifted from its contract, and
                // the symptom otherwise is an index that quietly stops recording something.
                log(`WARNING: ${stats.undecodable} logs did not decode; check the ABIs`);
            }
        },

        onProgress: (cursor: TailerCursor) => {
            db.setCursor(cursor);
            // Heartbeat, so a long quiet walk still shows progress without one line per pass.
            if (cursor.blockNumber - lastReport >= 5_000) {
                lastReport = cursor.blockNumber;
                log(`at block ${cursor.blockNumber} (${totals.applied} events applied so far)`);
            }
        },

        onReorg: (toBlock) => {
            log(`REORG: the chain changed under the cursor; rolling back above block ${toBlock}`);
            db.batch(() => db.rollbackAbove(toBlock));
        },

        onScan: (scanned, block) => {
            if (scanned % 50 === 0) log(`  ...scanned ${scanned} windows (at block ${block})`);
        },

        onError: (message, expected) => {
            // Routine public-endpoint noise logs at warn. Demoting it is what keeps a real outage
            // visible instead of buried in rate-limit chatter.
            if (expected) log(`transient: ${message}`);
            else console.error(`[indexer] ERROR: ${message}`);
        },
    });

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`${signal} received, stopping`);
        tailer.stop();
        await tailer.done;
        // The cursor is already persisted on every pass; closing cleanly is what avoids a
        // stale WAL that the read-only gateway would then have to recover.
        db.close();
        log(`stopped (${totals.applied} events applied this run)`);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await tailer.done;
}

// tsx runs this file directly; the gateway imports `main` instead when it runs both in one
// process. Windows note: comparing against `file://${process.argv[1]}` is broken there, because
// argv[1] is a backslash path while import.meta.url is a file:/// URL — hence pathToFileURL.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    main().catch((err: unknown) => {
        console.error(err instanceof Error ? err.stack : String(err));
        process.exitCode = 1;
    });
}
