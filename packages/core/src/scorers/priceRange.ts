/**
 * price-range-guess — port of the Sui engine's `scoring/price_range.rs`.
 *
 * The agent commits a [minPrice, maxPrice] band; ground truth is the FTSO price at resolution.
 * End price inside the band scores 100. Outside it, a LINEAR decay against a tolerance that is
 * start-price-relative and scaled by sqrt(lifetime), so a longer window earns a wider grace band
 * and the score cannot be gamed by guessing an absurdly wide range. A degenerate band is an agent
 * fault and scores 0.
 *
 * Pure integer/bigint math throughout, for byte-identical replay.
 */

import { type ScorerVerdict, type ScorerInput, isqrt, clampScore, readInt } from './types.js';

/** Basis-points denominator for the tolerance scale: tol = start * sqrt(lifetimeSecs) / 10000. */
const TOL_BPS_DENOM = 10_000n;

export interface PriceRangeGuess {
    readonly minPrice: bigint;
    readonly maxPrice: bigint;
}

/**
 * Score a price-range guess. All prices are integers in the feed's decimals.
 *
 * @param guess         the agent's committed band
 * @param endPrice      the resolved ground-truth price (FTSO anchor value at resolution)
 * @param startPrice    the price captured at entry/delivery (sets the tolerance scale)
 * @param lifetimeSecs  the competition/job lifetime in seconds (widens the grace band)
 */
export function scorePriceRange(
    guess: PriceRangeGuess,
    endPrice: bigint,
    startPrice: bigint,
    lifetimeSecs: number,
): ScorerVerdict {
    // A non-positive-width band is degenerate, mirroring price_range.rs rejecting
    // maxPrice <= minPrice. Note this is STRICTER than the intake template, which allows
    // min == max: a single-point "band" is well-formed enough to be paid for and worthless
    // enough to score 0. That asymmetry is deliberate — payment is for honest work delivered
    // on time, reputation is for being right.
    if (guess.maxPrice <= guess.minPrice) {
        return { ok: false, agentFault: true, reason: 'maxPrice must be greater than minPrice' };
    }
    if (startPrice <= 0n) {
        return { ok: false, agentFault: true, reason: 'invalid start price' };
    }

    if (endPrice >= guess.minPrice && endPrice <= guess.maxPrice) {
        return { ok: true, score: 100 };
    }

    const distance =
        endPrice < guess.minPrice ? guess.minPrice - endPrice : endPrice - guess.maxPrice;

    const sqrtLife = isqrt(BigInt(Math.max(0, Math.floor(lifetimeSecs))));
    const tolerance = (startPrice * sqrtLife) / TOL_BPS_DENOM;
    if (tolerance <= 0n) {
        // Sub-second window or a tiny start price leaves no grace at all: outside is 0.
        return { ok: true, score: 0 };
    }

    // Linear decay: 100 at the band edge, 0 once distance reaches the tolerance.
    const penalty = Number((100n * distance) / tolerance);
    return { ok: true, score: clampScore(100 - penalty) };
}

/** The registry adapter: pull the band out of a revealed submission, then score it. */
export function scorePriceRangeInput(input: ScorerInput): ScorerVerdict {
    const min = readInt(input.revealed, 'minPrice');
    if (typeof min !== 'bigint') return min;
    const max = readInt(input.revealed, 'maxPrice');
    if (typeof max !== 'bigint') return max;
    return scorePriceRange(
        { minPrice: min, maxPrice: max },
        input.endPrice,
        input.startPrice,
        input.lifetimeSecs,
    );
}
