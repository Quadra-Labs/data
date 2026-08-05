/**
 * jobParams.ts — the encoding of a paid job's SCOPE, carried in JobEscrow's `params` bytes and
 * emitted on `JobPaid`. This is how a buyer says WHAT they want forecast (which asset) rather
 * than relying on the agent to guess.
 *
 * It lives in the core because the writer (any dApp or console) and the reader (the agent bot,
 * the keeper, the indexer) are different processes in different repos, and a format agreed in
 * several places drifts.
 *
 * Deliberately plain JSON in UTF-8 bytes, not ABI encoding: params is an open-ended per-evaluator
 * scope blob, and a forward-compatible bag of keys beats a rigid tuple that every new field
 * breaks. Nothing here is trust-critical — params is public and the SCORER never reads it, since
 * the settlement is derived from the feed and the sealed result. A malformed blob must therefore
 * degrade, never throw: a user can put arbitrary bytes on chain, and an agent that was already
 * paid must not crash on them.
 */

import { toHex, fromHex, type Hex } from 'viem';

export interface JobParams {
    /**
     * Bare base symbol, e.g. "BTC".
     *
     * Explicitly `| undefined` because callers build this from optional form fields and pass
     * `{ asset: someMaybeUndefined }` directly — which `exactOptionalPropertyTypes` otherwise
     * rejects. `encodeJobParams` filters undefined values out, so the two agree.
     */
    readonly asset?: string | undefined;
    /** Free-form extra scope a specific evaluator may define. */
    readonly [key: string]: unknown;
}

/** Encode job scope for `JobEscrow.payForJob(params)`. Empty scope encodes as "0x". */
export function encodeJobParams(params: JobParams): Hex {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '0x';
    return toHex(JSON.stringify(Object.fromEntries(entries)));
}

/** Decode job scope. Returns {} for empty or unparseable params — see the header. */
export function decodeJobParams(params: Hex | undefined): JobParams {
    if (!params || params === '0x') return {};
    try {
        const parsed: unknown = JSON.parse(fromHex(params, 'string'));
        return typeof parsed === 'object' && parsed !== null ? (parsed as JobParams) : {};
    } catch {
        return {};
    }
}

/**
 * The asset a job asks for, normalized to a bare base symbol, or undefined if unspecified.
 * "btc/usd", "BTC-USD", "BTCUSD" and "BTC" all normalize to "BTC".
 */
export function jobAsset(params: Hex | undefined): string | undefined {
    const raw = decodeJobParams(params).asset;
    if (typeof raw !== 'string') return undefined;
    const upper = raw.trim().toUpperCase();
    const base = upper.split(/[/\-_]/)[0] ?? upper;
    const symbol = base.endsWith('USD') && base.length > 3 ? base.slice(0, -3) : base;
    return symbol.length > 0 ? symbol : undefined;
}
