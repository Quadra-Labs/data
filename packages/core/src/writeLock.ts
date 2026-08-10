/**
 * Per-account transaction serialization.
 *
 * Every transaction from one key consumes that key's next nonce. Two in flight at once are
 * assigned the SAME nonce by any client that reads it independently, and the loser is dropped
 * by the node as "nonce too low" or "replacement transaction underpriced" — a failure that
 * looks like a network blip but is really a race, and that retrying does not fix because the
 * retry races too. Chain every send through one lock per account so a key has at most one
 * transaction in flight.
 *
 * The Sui original keyed a WeakMap on the client object, which only serialized callers that
 * happened to share one client instance. The nonce belongs to the ACCOUNT, not the client, so
 * two clients built from the same key must contend on the same lock — hence a string key.
 *
 * Nothing inside `data` sends transactions; this lives here for the engines that do
 * (intake-engine's release/refund path and the FCC relayer), so they stop each inventing a
 * queue. Do not delete it as dead code.
 *
 * The guarantee is only as wide as the task handed in. A task that returns at BROADCAST releases
 * the lock while its transaction is still pending, and the next send then simulates against a
 * state that does not include it — the very race described above. Hold the lock until the
 * receipt.
 */
// One entry per account, never pruned: the value is a settled promise (a few bytes) and the set
// of accounts a process signs for is fixed at boot. Pruning safely needs a waiter count — a bare
// `delete` in a `finally` would drop the chain a queued caller is waiting behind and un-serialize
// it, which is worse than the leak it fixes.
const chains = new Map<string, Promise<unknown>>();

export function withWriteLock<T>(account: string, task: () => Promise<T>): Promise<T> {
    const key = account.toLowerCase();
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(task);
    // Swallow both outcomes on the CHAIN only: one failed send must not reject every write
    // queued behind it. The caller still sees its own rejection through `run`.
    chains.set(
        key,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
}
