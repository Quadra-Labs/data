import type { JsonValue, WalrusJsonClient } from 'walrus-json';

import { withWriteLock } from '../writeLock.js';

/**
 * A typed wrapper around one pointer-backed JSON document.
 *
 * Reads resolve the pointer to its current blob; writes read the current value,
 * apply a pure mutator in memory, then write a brand-new blob and re-point the
 * `JsonPointer` to it in a single `commit`. The whole-document replace keeps the
 * data fully typed in TypeScript instead of threading dot-paths.
 */
export class PointerDoc<T> {
    // Stale-while-revalidate cache of the resolved document. Active only when cacheTtlMs > 0,
    // so docs that do not opt in resolve the pointer fresh on every read (unchanged behavior).
    #cache?: { value: T; expiresAt: number };
    // Coalesces concurrent resolves into one Walrus read (a thundering herd of readers on a
    // cold cache shares a single in-flight fetch instead of each paying the latency).
    #inflight?: Promise<T>;

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
        if (this.cacheTtlMs <= 0) return this.#resolve();

        const cached = this.#cache;
        if (cached !== undefined) {
            // Stale-while-revalidate: return immediately; if expired, revalidate in the
            // background (deduped) without making this reader wait.
            if (Date.now() >= cached.expiresAt) void this.#refresh().catch(() => undefined);
            return cached.value;
        }
        // Cold cache: the first reader waits for the resolve; concurrent readers share it.
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
     * Force-resolve the pointer now and store it in the cache, returning the fresh value. Used to
     * WARM the cache on boot (the slow Walrus resolve happens here, in the background, never on a
     * reader's request) and to invalidate it on an external pointer change. When caching is off it
     * just resolves and returns.
     */
    async prime(): Promise<T> {
        const value = await this.#resolve();
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
     * Read, apply `mutator` to a clone, then persist the result as a new blob and
     * re-point. Returns the persisted value. Serialized per client (the wallet has
     * one transaction in flight at a time): overlapping writes — same pointer or
     * not — would spend the same pointer version or gas/WAL coins and equivocate.
     */
    update(mutator: (current: T) => T): Promise<T> {
        return withWriteLock(this.wj, () => this.#commit(mutator));
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
