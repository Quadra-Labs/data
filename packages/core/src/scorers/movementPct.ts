/**
 * movement-percentage-guess — port of the Sui engine's `scoring/movement_pct.rs`.
 *
 * The agent predicts how far the asset moves over the window, signed. Scored on a Lorentzian
 * decay rather than a threshold, so a near miss is not punished like a wild one:
 *
 *   actual = (endPrice - startPrice) * 10000 / startPrice     (basis points, signed)
 *   err    = |guess - actual|
 *   score  = 100 * TOL^2 / (TOL^2 + err^2)                    (TOL = 1000 bps = 10%)
 *
 * err 0 -> 100, err 500bps -> 80, err 1000bps -> 50, err 2000bps -> 20. No cliff anywhere, which
 * matters because hitting an exact percentage is genuinely hard and a threshold rule would make
 * the difference between 9.9% and 10.1% worth more than the difference between 10% and 50%.
 *
 * UNITS CHANGED IN THE PORT. The Rust took `percentage` as an f64 (`5.0` meaning +5%) and
 * immediately rounded it to basis points. Here it arrives as SIGNED INTEGER BASIS POINTS, which
 * removes the float entirely — `500` is +5%, `-300` is -3%. A scorer that touches a float cannot
 * be replayed byte-identically, and the audit trail rests on replayability.
 *
 * SIGN MATTERS, and that is the point: predicting +5% when the market fell 5% is a 1000bps error
 * and scores 50, not 100.
 */

import { type ScorerVerdict, type ScorerInput, readInt } from './types.js';

/** The half-score point: an error of this many basis points scores 50. 1000 bps = 10%. */
const TOL_BPS = 1_000n;

export interface MovementGuess {
    /** Signed basis points. 500 = +5%. */
    readonly bps: bigint;
}

export function scoreMovementPct(
    guess: MovementGuess,
    endPrice: bigint,
    startPrice: bigint,
): ScorerVerdict {
    if (startPrice <= 0n) {
        return { ok: false, agentFault: true, reason: 'invalid start price' };
    }

    // Truncates toward zero, matching Rust's i128 division. A negative move truncates UP, which is
    // a one-basis-point difference on the pessimistic side and is preserved rather than "fixed":
    // the Sui settlements were computed this way.
    const actualBps = ((endPrice - startPrice) * 10_000n) / startPrice;

    const err = guess.bps - actualBps;
    const absErr = err < 0n ? -err : err;
    const tol2 = TOL_BPS * TOL_BPS;
    const score = (100n * tol2) / (tol2 + absErr * absErr);

    return { ok: true, score: Number(score > 100n ? 100n : score) };
}

export function scoreMovementPctInput(input: ScorerInput): ScorerVerdict {
    const bps = readInt(input.revealed, 'percentageBps');
    if (typeof bps !== 'bigint') return bps;
    return scoreMovementPct({ bps }, input.endPrice, input.startPrice);
}
