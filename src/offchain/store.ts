/**
 * Durable off-chain write-behind store (SQLite, WAL). The gateway commits every
 * write here FIRST — synchronously, in well under a millisecond — and returns to
 * the caller immediately. A background worker then flushes each change to Walrus +
 * Sui. This file is the durable substrate: it survives a restart, so a crash before
 * the on-chain flush loses nothing — the worker resumes from what is recorded here.
 *
 * Two tables:
 *  - doc_state: the latest desired value of each pointer-backed JSON document, with
 *    a monotonic `version` and the last `flushed_ver` written on-chain. A row is
 *    "dirty" (needs flushing) while version > flushed_ver. Whole-document replace
 *    semantics mean rapid writes naturally coalesce: only the latest value is flushed.
 *  - pending_result: sealed job-result envelopes held until their Walrus blob lands.
 *    Served directly from here meanwhile, so a result is fetchable the instant it is
 *    stored, before it is durable on Walrus.
 *
 * WAL mode matches the indexer DB (one writer, many readers on the same host).
 */
import Database from 'better-sqlite3';
import type { JsonValue } from 'walrus-json';

import type { SealedResultBlob } from '../types.js';

/** The latest recorded value of one pointer-backed document. */
export interface DocSnapshot {
    value: JsonValue;
    /** Bumped on every write; the flush target. */
    version: number;
    /** Highest version successfully written on-chain. Dirty while version > flushedVer. */
    flushedVer: number;
}

/** A sealed result envelope held until its Walrus blob is durable. */
export interface PendingResult {
    jobId: string;
    sealed: SealedResultBlob;
    /** The real Walrus blob id once flushed; null while still pending. */
    blobId: string | null;
    flushed: boolean;
}

interface DocRow {
    value_json: string;
    version: number;
    flushed_ver: number;
}

interface ResultRow {
    sealed_json: string;
    blob_id: string | null;
    flushed: number;
}

// better-sqlite3's Statement generics are finicky across object- vs array-bound params, so the
// prepared statements are held loosely and their row shapes are asserted at each call site.
type Stmt = Database.Statement;

export class OffchainStore {
    readonly #db: Database.Database;

    readonly #getDoc: Stmt;
    readonly #putDoc: Stmt;
    readonly #baseline: Stmt;
    readonly #flushDoc: Stmt;
    readonly #dirtyDocs: Stmt;

    readonly #getResult: Stmt;
    readonly #putResult: Stmt;
    readonly #flushResult: Stmt;
    readonly #pendingResults: Stmt;

    constructor(path: string) {
        this.#db = new Database(path);
        this.#db.pragma('journal_mode = WAL');
        this.#db.pragma('synchronous = NORMAL');
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS doc_state (
                pointer_id  TEXT PRIMARY KEY,
                value_json  TEXT NOT NULL,
                version     INTEGER NOT NULL,
                flushed_ver INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_result (
                job_id      TEXT PRIMARY KEY,
                sealed_json TEXT NOT NULL,
                blob_id     TEXT,
                flushed     INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
            );
        `);

        this.#getDoc = this.#db.prepare(
            'SELECT value_json, version, flushed_ver FROM doc_state WHERE pointer_id = ?',
        );
        // Insert at version 1, or bump version on every subsequent write. RETURNING hands
        // back the new version without a second round-trip.
        this.#putDoc = this.#db.prepare(`
            INSERT INTO doc_state (pointer_id, value_json, version, flushed_ver, updated_at)
            VALUES (@id, @val, 1, 0, @now)
            ON CONFLICT(pointer_id) DO UPDATE SET
                value_json = @val, version = version + 1, updated_at = @now
            RETURNING version
        `);
        // Adopt an on-chain value as a CLEAN baseline (flushed_ver = version): used on boot to
        // reconcile pointers an external process (seed/bootstrap) wrote while the gateway was down.
        this.#baseline = this.#db.prepare(`
            INSERT INTO doc_state (pointer_id, value_json, version, flushed_ver, updated_at)
            VALUES (@id, @val, 1, 1, @now)
            ON CONFLICT(pointer_id) DO UPDATE SET
                value_json = @val, flushed_ver = version, updated_at = @now
        `);
        this.#flushDoc = this.#db.prepare(
            'UPDATE doc_state SET flushed_ver = MAX(flushed_ver, @ver) WHERE pointer_id = @id',
        );
        this.#dirtyDocs = this.#db.prepare(
            'SELECT pointer_id FROM doc_state WHERE version > flushed_ver',
        );

        this.#getResult = this.#db.prepare(
            'SELECT sealed_json, blob_id, flushed FROM pending_result WHERE job_id = ?',
        );
        this.#putResult = this.#db.prepare(`
            INSERT INTO pending_result (job_id, sealed_json, blob_id, flushed, created_at)
            VALUES (@id, @sealed, NULL, 0, @now)
            ON CONFLICT(job_id) DO UPDATE SET sealed_json = @sealed, blob_id = NULL, flushed = 0
        `);
        this.#flushResult = this.#db.prepare(
            'UPDATE pending_result SET blob_id = @blob, flushed = 1 WHERE job_id = @id',
        );
        this.#pendingResults = this.#db.prepare(
            'SELECT job_id FROM pending_result WHERE flushed = 0',
        );
    }

    // --- pointer-backed documents -----------------------------------------

    /** The latest recorded snapshot of a pointer doc, or undefined if never written. */
    getDoc(pointerId: string): DocSnapshot | undefined {
        const row = this.#getDoc.get(pointerId) as DocRow | undefined;
        if (!row) return undefined;
        return {
            value: JSON.parse(row.value_json) as JsonValue,
            version: row.version,
            flushedVer: row.flushed_ver,
        };
    }

    /** Record a new value (bumps version, marks dirty). Returns the new version. */
    putDoc(pointerId: string, value: JsonValue, now: number): number {
        const row = this.#putDoc.get({ id: pointerId, val: JSON.stringify(value), now }) as
            | { version: number }
            | undefined;
        return row?.version ?? 1;
    }

    /** Record an on-chain value as a clean (already-flushed) baseline. */
    putBaseline(pointerId: string, value: JsonValue, now: number): void {
        this.#baseline.run({ id: pointerId, val: JSON.stringify(value), now });
    }

    /** Mark a version as flushed on-chain (clears dirty unless a newer write raced in). */
    markDocFlushed(pointerId: string, version: number): void {
        this.#flushDoc.run({ id: pointerId, ver: version });
    }

    /** Pointer ids with un-flushed writes (version > flushed_ver). */
    dirtyDocs(): string[] {
        return (this.#dirtyDocs.all() as { pointer_id: string }[]).map((r) => r.pointer_id);
    }

    // --- sealed job results -----------------------------------------------

    /** Hold a sealed result envelope until its Walrus blob is durable. */
    putPendingResult(jobId: string, sealed: SealedResultBlob, now: number): void {
        this.#putResult.run({ id: jobId, sealed: JSON.stringify(sealed), now });
    }

    /** A held result envelope, or undefined if none recorded for this job. */
    getPendingResult(jobId: string): PendingResult | undefined {
        const row = this.#getResult.get(jobId) as ResultRow | undefined;
        if (!row) return undefined;
        return {
            jobId,
            sealed: JSON.parse(row.sealed_json) as SealedResultBlob,
            blobId: row.blob_id,
            flushed: row.flushed === 1,
        };
    }

    /** Record that a result's blob is now durable on Walrus under `blobId`. */
    markResultFlushed(jobId: string, blobId: string): void {
        this.#flushResult.run({ id: jobId, blob: blobId });
    }

    /** Job ids whose sealed blob has not yet landed on Walrus. */
    pendingResults(): string[] {
        return (this.#pendingResults.all() as { job_id: string }[]).map((r) => r.job_id);
    }

    close(): void {
        this.#db.close();
    }
}
