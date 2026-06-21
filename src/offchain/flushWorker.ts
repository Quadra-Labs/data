/**
 * Background flusher: drains the off-chain store to Walrus + Sui. The request path
 * never waits on this — a write returns the instant it is durable in SQLite, and
 * this worker carries it to chain afterwards.
 *
 * Design:
 *  - Pokes are edge-triggered: `update`/`storeSealed` call pokeDoc/pokeResult, the
 *    worker drains everything currently dirty, fast.
 *  - A periodic sweep re-scans the store, so writes left dirty by a failed flush (or
 *    by a crash before this process started) are retried without needing a new poke.
 *  - All on-chain writes share one wallet, so the underlying PointerDoc/JobResults
 *    flush takes the per-client write lock; the worker drains sequentially anyway.
 *  - A flush that throws leaves its entry dirty and ends the drain pass; the next
 *    sweep retries it. That bounds the retry rate on a persistent failure to one
 *    attempt per sweep instead of a hot loop.
 */

/** A pointer-backed document the worker can push on-chain. */
export interface Flushable {
    readonly pointerId: string;
    /** Write the store's current value on-chain. Throws to request a retry. */
    flushCurrent(): Promise<void>;
}

/** Pushes a held sealed result to Walrus and indexes it. */
export interface ResultFlusher {
    flushResult(jobId: string): Promise<void>;
}

interface StoreView {
    dirtyDocs(): string[];
    pendingResults(): string[];
}

export interface FlushWorkerOptions {
    /** Periodic re-scan + retry cadence (ms). */
    sweepMs?: number;
    /** Optional structured logger; falls back to console. */
    log?: { info(msg: string): void; warn(msg: string): void };
}

export class FlushWorker {
    readonly #store: StoreView;
    readonly #docs = new Map<string, Flushable>();
    #results?: ResultFlusher;

    readonly #dirtyDocs = new Set<string>();
    readonly #dirtyResults = new Set<string>();

    readonly #sweepMs: number;
    readonly #log: { info(msg: string): void; warn(msg: string): void };

    #draining = false;
    // Set whenever new work appears (poke or sweep). The drain loop re-checks it after each pass,
    // so an item poked WHILE a drain is already running is picked up in the same loop instead of
    // waiting for the next sweep.
    #redrain = false;
    #stopped = false;
    #timer?: ReturnType<typeof setInterval>;

    constructor(store: StoreView, options: FlushWorkerOptions = {}) {
        this.#store = store;
        this.#sweepMs = options.sweepMs ?? 5_000;
        this.#log = options.log ?? console;
    }

    /** Register a pointer doc so the worker can flush it by id. */
    registerDoc(doc: Flushable): void {
        this.#docs.set(doc.pointerId, doc);
    }

    /** Register the sealed-result flusher (the JobResults instance). */
    setResultFlusher(flusher: ResultFlusher): void {
        this.#results = flusher;
    }

    /** Note a pointer doc as dirty and kick a drain. */
    pokeDoc(pointerId: string): void {
        this.#dirtyDocs.add(pointerId);
        this.#wake();
    }

    /** Note a held result as dirty and kick a drain. */
    pokeResult(jobId: string): void {
        this.#dirtyResults.add(jobId);
        this.#wake();
    }

    /** Recover anything left dirty (e.g. by a prior crash) and start the sweep. */
    start(): void {
        this.#stopped = false;
        this.#recover();
        this.#timer = setInterval(() => {
            this.#recover();
            this.#wake();
        }, this.#sweepMs);
        // Do not keep the process alive solely for the sweep.
        this.#timer.unref?.();
        this.#wake();
    }

    /** Stop the sweep and attempt one final best-effort drain. */
    async stop(): Promise<void> {
        this.#stopped = true;
        if (this.#timer) clearInterval(this.#timer);
        this.#recover();
        await this.#drain();
    }

    // Signal that there is work to attempt and ensure a drain loop is running. Idle when there is
    // nothing dirty, so the periodic sweep does not spin on empty.
    #wake(): void {
        if (this.#dirtyDocs.size === 0 && this.#dirtyResults.size === 0) return;
        this.#redrain = true;
        void this.#kick();
    }

    /** Number of items currently known to be dirty (for shutdown/tests). */
    pendingCount(): number {
        return this.#dirtyDocs.size + this.#dirtyResults.size;
    }

    #recover(): void {
        for (const id of this.#store.dirtyDocs()) this.#dirtyDocs.add(id);
        for (const jobId of this.#store.pendingResults()) this.#dirtyResults.add(jobId);
    }

    async #kick(): Promise<void> {
        if (this.#draining || this.#stopped) return;
        this.#draining = true;
        try {
            // Drain repeatedly while work keeps arriving; stop the loop on a failure so retries
            // fall to the sweep cadence rather than spinning.
            while (this.#redrain) {
                this.#redrain = false;
                if (!(await this.#drain())) break;
            }
        } finally {
            this.#draining = false;
        }
    }

    // Flush everything currently dirty. Returns true if it drained cleanly, false if a flush failed
    // (the item stays dirty for the next sweep to retry). Success clears the item and continues.
    async #drain(): Promise<boolean> {
        for (const pointerId of [...this.#dirtyDocs]) {
            const doc = this.#docs.get(pointerId);
            if (!doc) {
                this.#dirtyDocs.delete(pointerId); // nothing registered can flush it
                continue;
            }
            try {
                await doc.flushCurrent();
                this.#dirtyDocs.delete(pointerId);
            } catch (err) {
                this.#log.warn(`flush failed for ${pointerId}, will retry: ${String(err)}`);
                return false;
            }
        }

        if (this.#results) {
            for (const jobId of [...this.#dirtyResults]) {
                try {
                    await this.#results.flushResult(jobId);
                    this.#dirtyResults.delete(jobId);
                } catch (err) {
                    this.#log.warn(`result flush failed for ${jobId}, will retry: ${String(err)}`);
                    return false;
                }
            }
        }
        return true;
    }
}
