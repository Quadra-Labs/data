/**
 * json.ts — bigint-safe serialization.
 *
 * Every money field in the read model is a bigint, because QUADRA has 18 decimals and a JS number
 * loses precision above 2^53. `JSON.stringify` throws on a bigint rather than rounding it, which
 * is the right default and also means the HTTP layer must convert deliberately.
 *
 * Amounts go out as decimal STRINGS, not numbers. A client parsing `"1000000000000000000"` into a
 * JS number silently rounds it; a client parsing it into a BigInt does not. Sending a number would
 * make the rounding invisible and unavoidable.
 */

export function toJsonSafe(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(toJsonSafe);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
        );
    }
    return value;
}

export function serialize(value: unknown): string {
    return JSON.stringify(toJsonSafe(value));
}
