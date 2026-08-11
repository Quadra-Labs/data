/**
 * templates.ts — the JOB TEMPLATE: what a valid deliverable for an evaluator looks like.
 *
 * This is the intake gate, and it is deliberately NOT the scorer. Payment is released when the
 * agent delivered something WELL-FORMED for the job it was hired to do; whether the forecast
 * turns out to be ACCURATE is a separate, later question that only affects reputation.
 * Conflating the two would mean an agent that did honest work and delivered on time goes unpaid
 * because the market moved — nobody would take jobs on those terms.
 *
 * So the checks here are structural only, matching Quadra's "input checks only, no scoring": the
 * fields the evaluator needs are present, parse the way the scorer will parse them, and are
 * internally coherent. Nothing here reads market data.
 *
 * Compiled in rather than fetched from a mutable catalog, which is what the Sui version did
 * (`PUT /templates`, admin-gated). The TEE validates against this file, so it is part of the
 * measured code hash: a template fetched at runtime would let an operator redefine "valid
 * delivery" AFTER a job was paid for. The cost of that choice is real — adding an evaluator now
 * means rebuilding the TEE image and re-registering its code hash, where the Sui workflow was one
 * live HTTP call.
 */

export interface TemplateResult {
    readonly valid: boolean;
    /** Why it failed, for the release/refund decision log. Empty when valid. */
    readonly reason: string;
}

const ok: TemplateResult = { valid: true, reason: '' };
const fail = (reason: string): TemplateResult => ({ valid: false, reason });

/** The scorers read every field as BigInt(field), so anything that would throw there is invalid. */
function asBigInt(raw: string | undefined, field: string): bigint | TemplateResult {
    if (raw === undefined) return fail(`missing field "${field}"`);
    if (!/^-?\d+$/.test(raw.trim())) return fail(`field "${field}" is not an integer string`);
    try {
        return BigInt(raw.trim());
    } catch {
        return fail(`field "${field}" is not parseable as an integer`);
    }
}

function isResult(v: bigint | TemplateResult): v is TemplateResult {
    return typeof v !== 'bigint';
}

/** price-range-guess: a { minPrice, maxPrice } band in integer 1e-8 USD units. */
function priceRangeTemplate(result: Record<string, string>): TemplateResult {
    const min = asBigInt(result['minPrice'], 'minPrice');
    if (isResult(min)) return min;
    const max = asBigInt(result['maxPrice'], 'maxPrice');
    if (isResult(max)) return max;
    // A negative or zero bound is not a price. This is the exact shape an LLM produced when a
    // skill silently failed, and it is the reason intake validates at all.
    if (min <= 0n) return fail('minPrice must be positive');
    if (max <= 0n) return fail('maxPrice must be positive');
    // Note `min == max` passes here and scores 0 in the scorer. That asymmetry is intentional:
    // a single-point band is well-formed enough to have been honest work, and worthless enough
    // to earn no reputation.
    if (min > max) return fail('minPrice must be <= maxPrice');
    return ok;
}

/**
 * Every evaluator this marketplace can take jobs for. An unknown evaluator has no template, which
 * means intake cannot judge the delivery — treated as INVALID so the escrow refunds rather than
 * paying out for something nobody can check.
 */
/**
 * up-down-guess: a direction and a confidence in WHOLE PERCENT.
 *
 * The scorer clamps confidence into [50,100] rather than rejecting outside it, so this template
 * must not reject there either — the two would then disagree about whether the same delivery was
 * payable, and an agent would be refused payment for a submission the scorer was perfectly
 * willing to grade. It rejects only what is not a number or not a direction at all.
 */
function upDownTemplate(result: Record<string, string>): TemplateResult {
    const isUp = (result['isUp'] ?? '').trim().toLowerCase();
    if (isUp !== 'true' && isUp !== 'false') {
        return fail('field "isUp" must be "true" or "false"');
    }
    const confidence = asBigInt(result['confidence'], 'confidence');
    if (isResult(confidence)) return confidence;
    // A negative or absurd percent is not a weak signal, it is a broken producer.
    if (confidence < 0n || confidence > 100n) {
        return fail('confidence must be a whole percent in [0, 100]');
    }
    return ok;
}

/**
 * movement-percentage-guess: a signed move in BASIS POINTS. 500 is +5%.
 *
 * Bounded at +/- 1,000,000 bps (a 10,000x move) purely to catch a producer that emitted a price
 * where a percentage belonged — a mistake that otherwise delivers, gets paid, and scores 0.
 */
function movementPctTemplate(result: Record<string, string>): TemplateResult {
    const bps = asBigInt(result['percentageBps'], 'percentageBps');
    if (isResult(bps)) return bps;
    if (bps < -1_000_000n || bps > 1_000_000n) {
        return fail('percentageBps is outside +/-1000000 — is this a price rather than a move?');
    }
    return ok;
}

const TEMPLATES: Readonly<Record<string, (r: Record<string, string>) => TemplateResult>> = {
    'price-range-guess': priceRangeTemplate,
    'up-down-guess': upDownTemplate,
    'movement-percentage-guess': movementPctTemplate,
};

export function hasTemplate(evaluatorId: string): boolean {
    return evaluatorId in TEMPLATES;
}

export function templateIds(): string[] {
    return Object.keys(TEMPLATES);
}

/** Does this delivered result fit the evaluator's template? Structural only, never scoring. */
export function validateAgainstTemplate(
    evaluatorId: string,
    result: Record<string, string>,
): TemplateResult {
    const check = TEMPLATES[evaluatorId];
    if (check === undefined) return fail(`no template for evaluator "${evaluatorId}"`);
    if (Object.keys(result).length === 0) {
        return fail('result is empty or could not be decrypted');
    }
    return check(result);
}
