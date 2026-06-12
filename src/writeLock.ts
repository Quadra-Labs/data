/**
 * Per-client write serialization. Every Walrus write (pointer commit or blob
 * write) spends gas/WAL coins from the same wallet; two in flight at once pick
 * the same coins and equivocate ("object already locked", non-retriable). Chain
 * every write through one lock per client so a wallet has at most one
 * transaction in flight.
 */
const chains = new WeakMap<object, Promise<unknown>>();

export function withWriteLock<T>(client: object, task: () => Promise<T>): Promise<T> {
    const prev = chains.get(client) ?? Promise.resolve();
    const run = prev.then(task);
    chains.set(
        client,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
}
