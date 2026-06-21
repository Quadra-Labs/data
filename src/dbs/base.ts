import type { JsonValue, WalrusJsonClient } from 'walrus-json';

import { withWriteLock } from '../writeLock.js';
import type { KeyedLock } from '../offchain/keyedLock.js';
import type { OffchainStore } from '../offchain/store.js';
import type { Flushable, FlushWorker } from '../offchain/flushWorker.js';

/** The write-behind collaborators a PointerDoc needs to defer its on-chain write. */
interface WriteBehind {
    store: OffchainStore;
    worker: FlushWorker;
    lock: KeyedLock;
}

/**
 * A typed wrapper around one pointer-backed JSON document.
 *
 * Reads resolve the pointer to its current blob; writes read the current value,
 * apply a pure mutator in memory, then write a brand-new blob and re-point the
 * `JsonPointer` to it in a single `commit`. The whole-document replace keeps the
 * data fully typed in TypeScript instead of threading dot-paths.
 *
 * When WRITE-BEHIND is enabled (the gateway calls {@link enableWriteBehind}), a write
 * instead records the new value in the durable off-chain store and returns at once;
 * a background {@link FlushWorker} carries it to Walrus + Sui. The slow on-chain
 * commit leaves the request path entirely. Without it, writes stay fully synchronous
 * (the original behavior — used by read-only layers and tests).
 */
export class PointerDoc<T> implements Flushable {
    // Stale-while-revalidate cache of the resolved document. Active only when cacheTtlMs > 0,
    // so docs that do not opt in resolve the pointer fresh on every read (unchanged behavior).
    #cache?: { value: T; expiresAt: number };
    // Coalesces concurrent resolves into one Walrus read (a thundering herd of readers on a
    // cold cache shares a single in-flight fetch instead of each paying the latency).
    #inflight?: Promise<T>;
    // Present once the gateway opts this doc into write-behind. Absent = synchronous writes.
    #wb?: WriteBehind;

    constructor(
        protected readonly wj: WalrusJsonClient,
        readonly pointerId: string,
        protected readonly epochs: number,
        /**
         * When > 0, `read()` serves a cached value for this many ms, and keeps serving the stale
         * value while a single background refresh runs (so a slow `resolvePointer` never blocks a
         * reader after the first). Writes refresh the cache in place. 0 (default) disables caching:
         * every read resolves the pointer fresh. Set after construction with {@link enableCache}.
         */
        protected cacheTtlMs: number = 0,
    ) {}

    /** The current value of the document. */
    async read(): Promise<T> {
        if (this.cacheTtlMs <= 0) {
            // Caching off: still prefer a durable store value (read-your-writes even with the
            // cache disabled, e.g. tests), else resolve fresh.
            const st = this.#wb?.store.getDoc(this.pointerId);
            return st !== undefined ? (st.value as T) : this.#resolve();
        }

        const cached = this.#cache;
        if (cached !== undefined) {
            // Stale-while-revalidate: return immediately; if expired, revalidate in the
            // background (deduped) without making this reader wait.
            if (Date.now() >= cached.expiresAt) void this.#refresh().catch(() => undefined);
            return cached.value;
        }

        // Cold cache: prefer the durable store. It reflects this gateway's own writes,
        // INCLUDING ones not yet flushed on-chain (e.g. after a restart). Only fall back to a
        // Walrus resolve for a pointer this gateway has never written.
        const st = this.#wb?.store.getDoc(this.pointerId);
        if (st !== undefined) {
            this.#store(st.value as T);
            // Clean (fully flushed): an external seed could have moved chain ahead; revalidate
            // in the background. Dirty: the store is newer than chain, so leave it untouched.
            if (st.version <= st.flushedVer) void this.#refresh().catch(() => undefined);
            return st.value as T;
        }
        return this.#refresh();
    }

    /**
     * Turn on (or retune) stale-while-revalidate caching after construction. The gateway enables
     * this for every read-served pointer doc so reads come from memory; writes stay write-through.
     */
    enableCache(ttlMs: number): void {
        this.cacheTtlMs = Math.max(0, ttlMs);
    }

    /**
     * Opt this doc into write-behind: writes record to `store` and return; `worker` flushes them
     * on-chain later; `lock` serializes the per-pointer read-modify-write. Registers the doc with
     * the worker so it can flush by pointer id.
     */
    enableWriteBehind(wb: WriteBehind): void {
        this.#wb = wb;
        wb.worker.registerDoc(this);
    }

    /**
     * Force-resolve the pointer now and store it in the cache, returning the fresh value. Used to
     * WARM the cache on boot (the slow Walrus resolve happens here, in the background, never on a
     * reader's request) and to invalidate it on an external pointer change. When caching is off it
     * just resolves and returns.
     *
     * Under write-behind it also RECONCILES the off-chain store with chain: local un-flushed writes
     * win (and are re-queued to flush); otherwise the on-chain value is adopted as a clean baseline
     * (so a seed/bootstrap done while the gateway was down is picked up).
     */
    async prime(): Promise<T> {
        const value = await this.#resolve();
        const wb = this.#wb;
        if (wb) {
            const st = wb.store.getDoc(this.pointerId);
            if (st !== undefined && st.version > st.flushedVer) {
                this.#store(st.value as T);
                wb.worker.pokeDoc(this.pointerId); // ensure the un-flushed write still lands
                return st.value as T;
            }
            wb.store.putBaseline(this.pointerId, value as unknown as JsonValue, Date.now());
        }
        this.#store(value);
        return value;
    }

    async #resolve(): Promise<T> {
        return (await this.wj.resolvePointer(this.pointerId)) as unknown as T;
    }

    // Resolve the pointer and store it, coalescing concurrent calls into one fetch.
    #refresh(): Promise<T> {
        if (this.#inflight !== undefined) return this.#inflight;
        this.#inflight = (async () => {
            try {
                const value = await this.#resolve();
                this.#store(value);
                return value;
            } finally {
                this.#inflight = undefined;
            }
        })();
        return this.#inflight;
    }

    #store(value: T): void {
        if (this.cacheTtlMs > 0) this.#cache = { value, expiresAt: Date.now() + this.cacheTtlMs };
    }

    /**
     * Read, apply `mutator` to a clone, then persist the result. Returns the persisted value.
     *
     * Write-behind (gateway): records the new value in the durable store and returns at once; the
     * worker flushes it on-chain. The per-pointer lock serializes the read-modify-write so two
     * overlapping writes never drop an update — its critical section is CPU + synchronous SQLite
     * only, so it is never held across network I/O.
     *
     * Synchronous (no store): the original path — serialized per client (the wallet has one
     * transaction in flight at a time), reads current, mutates, writes a new blob and re-points.
     */
    update(mutator: (current: T) => T): Promise<T> {
        const wb = this.#wb;
        if (!wb) return withWriteLock(this.wj, () => this.#commit(mutator));

        return wb.lock.run(this.pointerId, async () => {
            const snap = wb.store.getDoc(this.pointerId);
            // First write to a pointer the store has not seen: base the mutation on the CURRENT
            // on-chain value so we never clobber existing data with a partial document. One-time
            // per pointer (boot warm seeds most baselines, so this rarely runs).
            const current = snap !== undefined ? (snap.value as T) : await this.#baseFromChain();
            const next = mutator(structuredClone(current));
            wb.store.putDoc(this.pointerId, next as unknown as JsonValue, Date.now());
            this.#store(next); // write-through to the read cache: instantly visible to reads
            wb.worker.pokeDoc(this.pointerId);
            return next;
        });
    }

    /** Resolve the on-chain value and seed it as the store baseline (first-write path). */
    async #baseFromChain(): Promise<T> {
        const value = await this.#resolve();
        this.#wb?.store.putBaseline(this.pointerId, value as unknown as JsonValue, Date.now());
        return value;
    }

    /**
     * Flush the store's current value on-chain (called by the worker). Whole-document replace, so
     * this writes the LATEST value — intermediate writes since the last flush are coalesced away.
     * Throws on failure so the worker retries; on success records the flushed version.
     */
    async flushCurrent(): Promise<void> {
        const wb = this.#wb;
        if (!wb) return;
        const snap = wb.store.getDoc(this.pointerId);
        if (!snap || snap.version <= snap.flushedVer) return; // nothing pending
        await withWriteLock(this.wj, async () => {
            const doc = await this.wj.openPointer(this.pointerId);
            doc.replace(snap.value as unknown as JsonValue);
            await doc.commit({ epochs: this.epochs });
        });
        wb.store.markDocFlushed(this.pointerId, snap.version);
    }

    async #commit(mutator: (current: T) => T): Promise<T> {
        const doc = await this.wj.openPointer(this.pointerId);
        const current = doc.toJSON() as unknown as T;
        const next = mutator(structuredClone(current));
        doc.replace(next as unknown as JsonValue);
        await doc.commit({ epochs: this.epochs });
        this.#store(next); // write-through: the gateway's own writes are instantly visible to reads.
        return next;
    }
}
