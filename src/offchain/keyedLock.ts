/**
 * Per-key in-process serialization. Chains async tasks for the same key so a
 * read-modify-write against the off-chain store never interleaves with another
 * write to the SAME pointer (two interleaved RMWs would drop an update). Tasks
 * for different keys run concurrently.
 *
 * The critical section a caller runs under this lock is CPU + synchronous SQLite
 * only (no network I/O), so the lock is never held across a slow operation.
 */
export class KeyedLock {
    readonly #chains = new Map<string, Promise<unknown>>();

    /** Run `task` once every previously queued task for `key` has settled. */
    run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
        const prev = this.#chains.get(key) ?? Promise.resolve();
        const next = prev.then(() => task());
        // Keep the chain alive regardless of success/failure so a thrown task does
        // not wedge the key; swallow here only to chain, the caller still sees errors.
        this.#chains.set(
            key,
            next.then(
                () => undefined,
                () => undefined,
            ),
        );
        return next;
    }
}
