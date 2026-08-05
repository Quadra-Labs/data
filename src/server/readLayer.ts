/**
 * readLayer.ts — answer from the index when it is trustworthy, from the chain when it is not.
 *
 * The gateway must serve before the indexer has ever run, which during a demo is the normal case.
 * So every read has two implementations and this decides which to use.
 *
 * Two fixes over the Sui version:
 *
 *   - **The gate is FRESHNESS, not existence.** It asked `agentCount() > 0`, so an index with rows
 *     but a cursor stuck an hour ago passed and served stale data as though it were live. This
 *     compares the cursor against the chain head.
 *   - **The probe is memoized.** It called `openReadonly` plus a `COUNT(*)` on EVERY request, so a
 *     gateway whose index never appeared paid a failed file open per request forever.
 */

import type { PublicClient } from 'viem';

import { IndexDb, openReadonly } from '../indexer/db.js';

export interface ReadLayerOptions {
    readonly dbPath: string;
    readonly client: PublicClient;
    /** Beyond this many blocks behind the head, the index is considered cold. */
    readonly maxLagBlocks: number;
    /** How long a freshness verdict is reused before re-checking. */
    readonly recheckMs?: number;
    /** How long to wait before re-probing for a database that was not there. */
    readonly retryMs?: number;
}

export interface IndexHealth {
    readonly present: boolean;
    readonly fresh: boolean;
    readonly cursor: number | undefined;
    readonly head: number | undefined;
    readonly lagBlocks: number | undefined;
    readonly agents: number;
    readonly jobs: number;
    readonly reason: string;
}

export interface ReadLayer {
    /** The index when it is fresh enough to serve, else undefined. Never throws. */
    index(): Promise<IndexDb | undefined>;
    /** What `/health` reports. Never throws. */
    health(): Promise<IndexHealth>;
    close(): void;
}

const COLD: IndexHealth = {
    present: false,
    fresh: false,
    cursor: undefined,
    head: undefined,
    lagBlocks: undefined,
    agents: 0,
    jobs: 0,
    reason: 'no index yet; serving live chain reads',
};

export function makeReadLayer(opts: ReadLayerOptions): ReadLayer {
    const recheckMs = opts.recheckMs ?? 5_000;
    const retryMs = opts.retryMs ?? 30_000;

    let db: IndexDb | undefined;
    let lastProbe = 0;
    let lastVerdict: IndexHealth = COLD;

    async function evaluate(): Promise<IndexHealth> {
        if (db === undefined) {
            db = openReadonly(opts.dbPath);
            if (db === undefined) return COLD;
        }

        let cursor: number | undefined;
        let agents = 0;
        let jobs = 0;
        try {
            cursor = db.getCursor()?.blockNumber;
            agents = db.agentCount();
            jobs = db.jobCount();
        } catch {
            // The file was removed or replaced underneath us. Drop the handle and re-probe.
            db.close();
            db = undefined;
            return { ...COLD, reason: 'the index became unreadable; serving live chain reads' };
        }

        if (cursor === undefined) {
            return { ...COLD, present: true, agents, jobs, reason: 'the indexer has not run yet' };
        }

        // If the chain is unreachable we cannot PROVE freshness — but an index with a cursor is
        // now the better source, not the worse one. Falling back to live chain reads because the
        // chain is unreachable is exactly backwards, and under a rate limit it makes the problem
        // worse: every route starts scanning, which deepens the throttling that caused it.
        let head: number;
        try {
            head = Number(await opts.client.getBlockNumber());
        } catch {
            return {
                present: true,
                fresh: true,
                cursor,
                head: undefined,
                lagBlocks: undefined,
                agents,
                jobs,
                reason: 'serving the index; the chain head could not be read to confirm freshness',
            };
        }
        const lagBlocks = head - cursor;
        const fresh = lagBlocks <= opts.maxLagBlocks;
        return {
            present: true,
            fresh,
            cursor,
            head,
            lagBlocks,
            agents,
            jobs,
            reason: fresh
                ? 'index is current'
                : `index is ${lagBlocks} blocks behind; serving live chain reads`,
        };
    }

    async function verdict(): Promise<IndexHealth> {
        const now = Date.now();
        const wait = lastVerdict.present ? recheckMs : retryMs;
        if (now - lastProbe < wait) return lastVerdict;
        lastProbe = now;
        try {
            lastVerdict = await evaluate();
        } catch {
            // Keep the last known verdict rather than declaring the index cold. A transient
            // failure while probing says nothing about whether the index is good.
            lastVerdict = {
                ...lastVerdict,
                reason: `${lastVerdict.reason} (last probe failed)`,
            };
        }
        return lastVerdict;
    }

    return {
        async index() {
            const v = await verdict();
            return v.present && v.fresh ? db : undefined;
        },
        health: verdict,
        close() {
            db?.close();
            db = undefined;
        },
    };
}
