/**
 * cache.ts — stale-while-revalidate with request coalescing.
 *
 * Extracted from the Sui `PointerDoc`, which used it to hide a ~10s Walrus resolve. The Walrus
 * resolve is gone; the need is if anything greater, because Coston2's public RPC caps `eth_getLogs`
 * at 30 blocks and rate-limits aggressively. A leaderboard assembled live is hundreds of calls, and
 * ten browser tabs asking at once should cost one.
 *
 * Two behaviours carry the weight:
 *
 *   - **Stale-while-revalidate.** An expired entry is served immediately and refreshed in the
 *     background, so exactly one reader ever pays the latency: the first.
 *   - **Coalescing.** Concurrent misses share one in-flight load. Without it a cold cache under
 *     load produces a thundering herd, which on a rate-limited endpoint is worse than no cache.
 *
 * One deliberate change from the original: a failed background refresh is recorded rather than
 * silently swallowed, so `/health` can report that reads are going stale instead of the gateway
 * quietly serving older and older data.
 */

export interface CachedOptions {
    /** Milliseconds an entry stays fresh. `<= 0` disables caching entirely. */
    readonly ttlMs: number;
    /** Called when a background refresh throws. The stale value keeps being served. */
    readonly onError?: ((err: unknown) => void) | undefined;
}

export class Cached<T> {
    // Declared `| undefined` rather than optional: under exactOptionalPropertyTypes, clearing an
    // optional field by assigning undefined is an error, and clearing is the whole point here.
    #entry: { value: T; expiresAt: number } | undefined;
    #inflight: Promise<T> | undefined;
    #lastError: unknown;

    constructor(
        private readonly load: () => Promise<T>,
        private readonly opts: CachedOptions,
    ) {}

    /** The value, fresh or stale. Blocks only on a cold cache. */
    async get(): Promise<T> {
        if (this.opts.ttlMs <= 0) return this.load();

        const entry = this.#entry;
        if (entry !== undefined) {
            if (Date.now() >= entry.expiresAt) void this.#refresh().catch(() => undefined);
            return entry.value;
        }
        return this.#refresh();
    }

    /**
     * Force a load now and cache it. Used to WARM on boot, so the slow first read happens in the
     * background at startup rather than on a user's request, and to invalidate-and-refill when an
     * indexed event says the underlying value moved.
     */
    async prime(): Promise<T> {
        return this.#refresh();
    }

    /** Write-through, so a caller that already knows the new value does not re-fetch it. */
    set(value: T): void {
        if (this.opts.ttlMs > 0) {
            this.#entry = { value, expiresAt: Date.now() + this.opts.ttlMs };
        }
    }

    /** Drop the entry. The next `get()` blocks until a fresh load completes. */
    invalidate(): void {
        this.#entry = undefined;
    }

    /** The cached value without triggering a load, or undefined when cold. */
    peek(): T | undefined {
        return this.#entry?.value;
    }

    /** Whether the cached value is past its TTL and being served stale. */
    get isStale(): boolean {
        const entry = this.#entry;
        return entry !== undefined && Date.now() >= entry.expiresAt;
    }

    /** The last background-refresh failure, if any. Cleared by the next success. */
    get lastError(): unknown {
        return this.#lastError;
    }

    #refresh(): Promise<T> {
        if (this.#inflight !== undefined) return this.#inflight;
        this.#inflight = (async () => {
            try {
                const value = await this.load();
                this.set(value);
                this.#lastError = undefined;
                return value;
            } catch (err) {
                this.#lastError = err;
                this.opts.onError?.(err);
                throw err;
            } finally {
                this.#inflight = undefined;
            }
        })();
        return this.#inflight;
    }
}

/**
 * The same policy, per key.
 *
 * For reads that are parameterised — one agent's track record, one competition's view — where a
 * single shared entry would be wrong and a cache per call site would not coalesce.
 */
export class KeyedCache<T> {
    readonly #entries = new Map<string, Cached<T>>();

    constructor(
        private readonly load: (key: string) => Promise<T>,
        private readonly opts: CachedOptions,
    ) {}

    get(key: string): Promise<T> {
        return this.#for(key).get();
    }

    prime(key: string): Promise<T> {
        return this.#for(key).prime();
    }

    set(key: string, value: T): void {
        this.#for(key).set(value);
    }

    /** Invalidate one key, or every key when called with no argument. */
    invalidate(key?: string): void {
        if (key === undefined) this.#entries.clear();
        else this.#entries.get(key)?.invalidate();
    }

    peek(key: string): T | undefined {
        return this.#entries.get(key)?.peek();
    }

    get size(): number {
        return this.#entries.size;
    }

    #for(key: string): Cached<T> {
        const existing = this.#entries.get(key);
        if (existing) return existing;
        const created = new Cached<T>(() => this.load(key), this.opts);
        this.#entries.set(key, created);
        return created;
    }
}

/** The result of warming a set of caches on boot: never throws, reports what failed. */
export interface WarmResult {
    readonly name: string;
    readonly ok: boolean;
    readonly error?: string;
}

/**
 * Warm several caches in parallel without letting one failure stop the others.
 *
 * The Sui gateway did this on boot and logged "caches warmed: ...". Worth keeping: an RPC that is
 * down at start-up must not prevent the process from serving, it must only make the first read
 * slow.
 */
export async function warmAll(
    entries: ReadonlyArray<readonly [string, () => Promise<unknown>]>,
): Promise<WarmResult[]> {
    return Promise.all(
        entries.map(async ([name, warm]): Promise<WarmResult> => {
            try {
                await warm();
                return { name, ok: true };
            } catch (err) {
                return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        }),
    );
}
