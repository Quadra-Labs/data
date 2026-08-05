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
const TEMPLATES: Readonly<Record<string, (r: Record<string, string>) => TemplateResult>> = {
    'price-range-guess': priceRangeTemplate,
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
