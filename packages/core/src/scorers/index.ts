/**
 * The scorer registry: evaluatorId -> the pure scoring function.
 *
 * There is ONE dispatch point, and both the TEE workload and the verify tool go through it. The
 * Flare reference dispatched by comparing `evaluatorId !== 'price-range-guess'` in three separate
 * places — two in the engine, one in the verifier — which means adding a scorer to the engine but
 * forgetting the verifier would silently make every settlement of the new kind unverifiable, with
 * the verifier reporting "skipped" rather than "wrong". A registry makes that impossible: a
 * missing entry fails both paths identically.
 *
 * Registering a new scorer: add it to SCORERS below, add its intake template in templates.ts, and
 * (if it needs a new data source) an FTSO feed in feeds.ts.
 */

export * from './types.js';
export { scorePriceRange, scorePriceRangeInput, type PriceRangeGuess } from './priceRange.js';
export { scoreUpDown, scoreUpDownInput, type UpDownGuess } from './upDown.js';
export { scoreMovementPct, scoreMovementPctInput, type MovementGuess } from './movementPct.js';

import type { Scorer } from './types.js';
import { scorePriceRangeInput } from './priceRange.js';
import { scoreUpDownInput } from './upDown.js';
import { scoreMovementPctInput } from './movementPct.js';

const SCORERS: Readonly<Record<string, Scorer>> = {
    'price-range-guess': scorePriceRangeInput,
    'up-down-guess': scoreUpDownInput,
    'movement-percentage-guess': scoreMovementPctInput,
};

/**
 * Evaluators this build KNOWS about but cannot replay from public data, with the reason.
 *
 * This is not a gap in the code. A price-range guess replays because both halves — the guess and
 * the resolved price — end up public. A trading return does not: it is derived from the
 * portfolio's own trades, which are private and stay private. The TEE still signs the metric and
 * the contract still verifies that signature, so the number is attested; it just cannot be
 * independently recomputed by a stranger.
 *
 * Recording it here rather than letting it fall through to "unknown evaluator" is the difference
 * between a verifier reporting a stated property and reporting a fault. See
 * _migration/KNOWN-CONSTRAINTS.md entry 2.
 */
const NOT_REPLAYABLE: Readonly<Record<string, string>> = {
    'portfolio-roi':
        "a trading return is derived from the portfolio's own trades, which are private; " +
        'the metric is TEE-signed and verified on chain, but there is no public input to recompute it from',
};

/** The evaluator ids this build can score. */
export const EVALUATOR_IDS = Object.keys(SCORERS) as readonly string[];

export function isEvaluatorId(value: string): boolean {
    return value in SCORERS;
}

/**
 * The scorer for an evaluator, or undefined if this build cannot score it.
 *
 * Undefined is meaningful and must not be swallowed: for the engine it means "refuse to score".
 * A verifier should use `replayability` instead, which separates the two very different reasons
 * a scorer might be missing.
 */
export function scorerFor(evaluatorId: string): Scorer | undefined {
    return SCORERS[evaluatorId];
}

/**
 * Can a settlement by this evaluator be re-derived from public data?
 *
 * Three answers, and conflating any two of them misleads a reader:
 *   - `replayable`     — run the scorer and compare.
 *   - `not-replayable` — by the nature of the evaluator, not by omission. Report it as such.
 *   - `unknown`        — this build has never heard of it. That is a real finding: either the
 *                        settlement predates/postdates this version, or it is not genuine.
 */
export type Replayability =
    | { readonly kind: 'replayable'; readonly scorer: Scorer }
    | { readonly kind: 'not-replayable'; readonly reason: string }
    | { readonly kind: 'unknown' };

export function replayability(evaluatorId: string): Replayability {
    const scorer = SCORERS[evaluatorId];
    if (scorer) return { kind: 'replayable', scorer };
    const reason = NOT_REPLAYABLE[evaluatorId];
    if (reason) return { kind: 'not-replayable', reason };
    return { kind: 'unknown' };
}
