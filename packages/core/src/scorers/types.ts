/**
 * The scorer contract, shared verbatim by the TEE workload (which SIGNS a score) and by the
 * verify tool (which REPLAYS it). Scorers MUST be pure and deterministic over integer inputs, or
 * a replay produces a different number than the settlement and every audit fails.
 *
 * All prices are integers in the FTSO feed's own decimals — never floats. This is the same
 * discipline as the Sui engine's 1e-8 fixed point, and for the same reason: two processes that
 * agree on a formula but disagree on floating-point rounding still disagree on the answer.
 */

/**
 * A scorer's verdict. `agentFault` means the submission itself was malformed or degenerate
 * rather than merely wrong; the caller records it as score 0. Quadra's engine called this the
 * BadAgentResult path.
 */
export type ScorerVerdict =
    | { readonly ok: true; readonly score: number } // 0..100 inclusive
    | { readonly ok: false; readonly agentFault: true; readonly reason: string };

/** Integer square root for bigint (Newton's method). Deterministic, floor(sqrt(n)). */
export function isqrt(n: bigint): bigint {
    if (n < 0n) throw new Error('isqrt: negative');
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

/** Clamp into [0, 100] and floor to an integer score. */
export function clampScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.floor(value)));
}

/**
 * What every scorer receives. Uniform across evaluators on purpose: the TEE and the verifier
 * both dispatch through one registry keyed by evaluatorId, and a per-scorer argument list would
 * mean each of them writing its own switch — which is exactly how a scoring path and a replay
 * path drift apart without anyone noticing.
 */
export interface ScorerInput {
    /** The decrypted submission, every field a string (that is what the envelope carries). */
    readonly revealed: Record<string, string>;
    /** The resolved ground-truth price at the end of the window. */
    readonly endPrice: bigint;
    /** The price captured when the window opened; sets the tolerance scale. */
    readonly startPrice: bigint;
    /** The scored window in seconds. */
    readonly lifetimeSecs: number;
}

export type Scorer = (input: ScorerInput) => ScorerVerdict;

/**
 * Parse a submission field the way every scorer must: reject anything `BigInt()` would throw on,
 * because a scorer may not throw. A malformed field is an agent fault, not a crash — the money
 * is already escrowed by the time we get here.
 */
export function readInt(
    revealed: Record<string, string>,
    field: string,
): bigint | { readonly ok: false; readonly agentFault: true; readonly reason: string } {
    const raw = revealed[field];
    if (raw === undefined) {
        return { ok: false, agentFault: true, reason: `missing field "${field}"` };
    }
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        return { ok: false, agentFault: true, reason: `field "${field}" is not an integer string` };
    }
    return BigInt(trimmed);
}

/**
 * The same, for a boolean field.
 *
 * Accepts only `"true"` and `"false"`, case-insensitively. Deliberately NOT truthiness: reading
 * `"0"` or `""` as false would silently turn a malformed submission into a confident prediction
 * of DOWN, and an agent would be scored on a call it never made.
 */
export function readBool(
    revealed: Record<string, string>,
    field: string,
): boolean | { readonly ok: false; readonly agentFault: true; readonly reason: string } {
    const raw = revealed[field];
    if (raw === undefined) {
        return { ok: false, agentFault: true, reason: `missing field "${field}"` };
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return { ok: false, agentFault: true, reason: `field "${field}" is not "true" or "false"` };
}
