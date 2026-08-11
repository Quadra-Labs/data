/**
 * up-down-guess — port of the Sui engine's `scoring/up_down.rs`.
 *
 * The agent says whether the asset will be higher at resolution than it was at the start, with a
 * confidence. Scored by the Brier rule mapped to [0,100]:
 *
 *   p_up    = isUp ? confidence : 100 - confidence     (percent it goes UP)
 *   outcome = endPrice > startPrice ? 100 : 0
 *   score   = 100 - (p_up - outcome)^2 / 100
 *
 * Certain and right -> 100. A coin flip (50) -> 75 either way. Certain and wrong -> 0. The curve
 * is what makes honesty pay: an agent that is unsure and says so loses less than one that is
 * confidently wrong, so there is no incentive to overstate.
 *
 * UNITS CHANGED IN THE PORT, for the same reason `price-range-guess` changed. The Rust took
 * `confidence` as an f64 in [0.5, 1] and rounded it to whole percent internally. Here it arrives
 * as an INTEGER PERCENT string, because a scorer that touches a float cannot be replayed to a
 * byte-identical result and the whole audit trail rests on it being replayable. The [50,100] clamp
 * is preserved verbatim: a confidence below 50 is not a weaker call, it is the OPPOSITE call, and
 * clamping rather than rejecting keeps a confused agent scoreable.
 *
 * TIE-BREAK PRESERVED: `endPrice > startPrice` is STRICT, so an unchanged price counts as DOWN.
 */

import { type ScorerVerdict, type ScorerInput, readInt, readBool } from './types.js';

export interface UpDownGuess {
    readonly isUp: boolean;
    /** Whole percent. Clamped into [50, 100] before scoring, exactly as the Rust did. */
    readonly confidencePct: bigint;
}

export function scoreUpDown(
    guess: UpDownGuess,
    endPrice: bigint,
    startPrice: bigint,
): ScorerVerdict {
    // Consistent with `scorePriceRange`, which classifies the same condition the same way. The
    // engine's own guard rejects a non-positive oracle price before a scorer ever sees it, so in
    // the settlement path this is unreachable; it exists for the verifier replaying old data.
    if (startPrice <= 0n) {
        return { ok: false, agentFault: true, reason: 'invalid start price' };
    }

    const confidence =
        guess.confidencePct < 50n ? 50n : guess.confidencePct > 100n ? 100n : guess.confidencePct;
    const pUp = guess.isUp ? confidence : 100n - confidence;
    const outcome = endPrice > startPrice ? 100n : 0n;

    const diff = pUp - outcome; // [-100, 100]
    const loss = (diff * diff) / 100n; // integer floor, [0, 100]
    const score = 100n - loss;

    return { ok: true, score: Number(score < 0n ? 0n : score > 100n ? 100n : score) };
}

export function scoreUpDownInput(input: ScorerInput): ScorerVerdict {
    const isUp = readBool(input.revealed, 'isUp');
    if (typeof isUp !== 'boolean') return isUp;
    const confidencePct = readInt(input.revealed, 'confidence');
    if (typeof confidencePct !== 'bigint') return confidencePct;
    return scoreUpDown({ isUp, confidencePct }, input.endPrice, input.startPrice);
}
