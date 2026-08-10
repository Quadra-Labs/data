/**
 * preflight.ts — the constants this build compiles in, checked against the chain before boot.
 *
 * Three numbers are declared in TypeScript and independently declared on chain: the app's price
 * precision, the performance-metric baseline, and the FTSO voting-epoch geometry. All three agree
 * today. The reason this file exists is what happens if one ever stops agreeing:
 *
 *   - PRICE_DECIMALS: every price is mis-scaled by a power of ten. No error anywhere.
 *   - PERF_BASE: every performance competition ranks against the wrong zero-ROI line, so the
 *     threshold eliminates the wrong entrants. Its getter has existed all along and NOTHING read
 *     it, which is the proof that a getter alone does not close this class of bug.
 *   - the voting epoch: the DA layer answers with a real finalized feed for the wrong INSTANT, the
 *     Merkle proof verifies on chain, and the settlement is scored against the wrong price.
 *
 * Every one of those produces a confident wrong answer that passes every other check. So the two
 * market constants are a HARD failure — refuse to boot rather than index against a contract this
 * build does not understand. The voting epoch is not: it has a chain-resolved value that simply
 * wins, so a mismatch is loud but survivable.
 *
 * It runs where a client already exists. `feeds.ts` deliberately does NOT read the chain — the
 * enclave image and the verifier both import it, and a verifier that dials the chain it audits is
 * a weaker verifier — so the constant stays declared there and is asserted here instead.
 */

import { parseAbi, type Address, type PublicClient } from 'viem';

import { PRICE_DECIMALS } from 'quadra-core';
import { resolveVotingEpoch, type VotingEpoch } from 'quadra-core/voting-epoch';

/** `PERF_BASE` as SealedCompetition declares it: `metric = PERF_BASE + roi_bps`. */
export const PERF_BASE = 1_000_000n;

const CONSTANTS_ABI = parseAbi([
    'function PRICE_DECIMALS() view returns (uint256)',
    'function PERF_BASE() view returns (uint64)',
]);

export interface PreflightResult {
    readonly ok: boolean;
    /** Fatal disagreements. Non-empty means do not boot. */
    readonly errors: readonly string[];
    /** Survivable notes, including a voting epoch that differs from the compiled-in fallback. */
    readonly warnings: readonly string[];
    /** The geometry to use for this run — chain-resolved when available. */
    readonly votingEpoch: VotingEpoch;
}

type Reader = Pick<PublicClient, 'readContract'>;

/**
 * Compare this build's constants against the deployment it is about to index.
 *
 * A missing selector is treated as a MISMATCH, not as a tolerated older contract. `PRICE_DECIMALS`
 * ships with the same redeploy as this check, so "the getter is not there" means the configured
 * address is a pre-hardening deployment — exactly the case worth refusing, because everything else
 * about it looks like it works.
 */
export async function preflight(
    client: Reader,
    addrs: { readonly jobEscrow: Address; readonly sealedCompetition: Address },
): Promise<PreflightResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const decimals = await Promise.all([
        readConstant(client, addrs.jobEscrow, 'PRICE_DECIMALS'),
        readConstant(client, addrs.sealedCompetition, 'PRICE_DECIMALS'),
    ]);
    const labels = ['JobEscrow', 'SealedCompetition'] as const;

    decimals.forEach((got, i) => {
        if (got === undefined) {
            errors.push(
                `${labels[i]} at ${i === 0 ? addrs.jobEscrow : addrs.sealedCompetition} has no ` +
                    `PRICE_DECIMALS() getter — this is a deployment from before the hardening pass, ` +
                    `and this build cannot tell what precision it prices in`,
            );
            return;
        }
        if (got !== BigInt(PRICE_DECIMALS)) {
            errors.push(
                `${labels[i]} says PRICE_DECIMALS is ${got}, this build says ${PRICE_DECIMALS} — ` +
                    'every price would be mis-scaled by a power of ten, silently',
            );
        }
    });

    const perfBase = await readConstant(client, addrs.sealedCompetition, 'PERF_BASE');
    if (perfBase === undefined) {
        errors.push(
            `SealedCompetition at ${addrs.sealedCompetition} did not answer PERF_BASE() — the ` +
                'configured address is not a SealedCompetition this build understands',
        );
    } else if (perfBase !== PERF_BASE) {
        errors.push(
            `SealedCompetition says PERF_BASE is ${perfBase}, this build says ${PERF_BASE} — ` +
                'every performance competition would rank against the wrong zero-ROI line',
        );
    }

    const resolved = await resolveVotingEpoch(client);
    if (resolved.warning !== undefined) warnings.push(resolved.warning);

    return { ok: errors.length === 0, errors, warnings, votingEpoch: resolved.epoch };
}

/** `undefined` distinguishes "the call reverted or the selector is absent" from a real value. */
async function readConstant(
    client: Reader,
    address: Address,
    functionName: 'PRICE_DECIMALS' | 'PERF_BASE',
): Promise<bigint | undefined> {
    try {
        const v = await client.readContract({ address, abi: CONSTANTS_ABI, functionName });
        return BigInt(v as bigint | number);
    } catch {
        return undefined;
    }
}

/**
 * Render the result for a boot log. Returns true when the process may continue.
 *
 * Takes both levels because the two callers log differently (a plain console vs. fastify's
 * logger), and because a warning here genuinely is a warning — the run continues on chain-resolved
 * values — while an error is a refusal to start.
 */
export function reportPreflight(
    result: PreflightResult,
    out: { warn: (line: string) => void; error: (line: string) => void },
): boolean {
    for (const w of result.warnings) out.warn(w);
    if (result.ok) return true;
    for (const e of result.errors) out.error(e);
    out.error(
        'refusing to start: indexing against a contract whose constants disagree with this build ' +
            'produces an index that looks correct and is not',
    );
    return false;
}
