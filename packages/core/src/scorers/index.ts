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

import type { Scorer } from './types.js';
import { scorePriceRangeInput } from './priceRange.js';

const SCORERS: Readonly<Record<string, Scorer>> = {
    'price-range-guess': scorePriceRangeInput,
};

/** The evaluator ids this build serves. */
export const EVALUATOR_IDS = Object.keys(SCORERS) as readonly string[];

export function isEvaluatorId(value: string): boolean {
    return value in SCORERS;
}

/**
 * The scorer for an evaluator, or undefined if this build does not know it.
 *
 * Undefined is meaningful and must not be swallowed: for the engine it means "refuse to score",
 * and for the verifier it means "this settlement was produced by a build that knew something this
 * one does not" — which is a real finding, not a passed check.
 */
export function scorerFor(evaluatorId: string): Scorer | undefined {
    return SCORERS[evaluatorId];
}
