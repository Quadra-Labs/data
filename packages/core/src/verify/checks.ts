/**
 * checks.ts — the PURE verification logic.
 *
 * Given data already fetched from chain, re-derive the outcome and report each check
 * independently. No chain I/O happens here, so the whole checklist is deterministic and can be
 * run by anyone, including a browser. This is the "don't trust us, re-derive it yourself" core.
 *
 * Every check answers one question and reports its own verdict. Nothing short-circuits: a failed
 * signature check must not hide a ground-truth mismatch, because a reader deciding whether to
 * trust a settlement needs the whole picture, not the first problem.
 */

import { keccak256, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from 'viem';

import { canonicalize, receiptHash, type Receipt } from '../receipt.js';
import { normalizeToPrice } from '../feeds.js';
import { replayability, type Scorer } from '../scorers/index.js';
import {
    competitionDomain,
    competitionTypes,
    jobDomain,
    jobTypes,
} from '../eip712.js';

/**
 * `skipped` is a distinct outcome, not a quiet pass.
 *
 * The Flare reference reported "score replay skipped by design" with ok:true and "no DA URL
 * configured" with ok:false — so a check nobody ran looked identical to one that passed, and a
 * missing config looked identical to a forged settlement. Both are misreadings a judge could
 * reasonably make from the output, so the state is explicit.
 */
export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface Check {
    readonly label: string;
    readonly status: CheckStatus;
    /** True only for `pass`. Convenience for filtering; `status` is the real answer. */
    readonly ok: boolean;
    readonly detail?: string;
}

function make(label: string, status: CheckStatus, detail?: string): Check {
    const base = { label, status, ok: status === 'pass' };
    return detail === undefined ? base : { ...base, detail };
}

const verdict = (label: string, ok: boolean, detail?: string): Check =>
    make(label, ok ? 'pass' : 'fail', detail);

const skip = (label: string, reason: string): Check => make(label, 'skipped', reason);

/** Parse the on-chain receipt body. Throws with a readable message rather than a JSON error. */
export function parseReceipt(receiptBody: Hex): Receipt {
    const text = Buffer.from(receiptBody.slice(2), 'hex').toString('utf8');
    try {
        return JSON.parse(text) as Receipt;
    } catch {
        throw new Error(
            'verify: the anchored receipt body is not valid JSON, so nothing about this ' +
                'settlement can be re-derived',
        );
    }
}

/** The receipt body is authentic, canonical, and anchored on chain. */
function receiptChecks(receiptBody: Hex, anchoredReceiptHash: Hex, receipt: Receipt): Check[] {
    const bodyHash = keccak256(receiptBody);
    const text = Buffer.from(receiptBody.slice(2), 'hex').toString('utf8');
    return [
        verdict(
            'receipt hash matches the on-chain anchor',
            bodyHash === anchoredReceiptHash,
            bodyHash,
        ),
        verdict(
            'receipt body is canonically encoded (re-serializes identically)',
            canonicalize(receipt) === text && receiptHash(receipt) === bodyHash,
        ),
    ];
}

/**
 * The receipt names the TEE image that produced it. Confirming that image is the one the registry
 * pins is what ties the numbers to attested code — without it the receipt's `teeImageDigest` is
 * an unchecked claim, which is the state the Flare reference shipped in.
 */
function imageDigestCheck(receipt: Receipt, registered: string | undefined): Check {
    const label = 'TEE image digest matches the one registered on chain';
    if (registered === undefined || registered.length === 0) {
        return skip(label, 'the TeeRegistry reports no expected image digest');
    }
    return verdict(label, receipt.teeImageDigest === registered, `receipt=${receipt.teeImageDigest}`);
}

/** Re-derive the recorded ground truth using the same rule the contract applies. */
function normalizeRecorded(receipt: Receipt): bigint | undefined {
    if (receipt.groundTruth.kind !== 'ftso-anchor') return undefined;
    try {
        // Deliberately the shared normalizeToPrice rather than a local copy: this rule lived in
        // three places in the reference (here with a hardcoded 8, in the engine, and in FtsoLib),
        // and three copies of a scaling rule is how a price ends up off by a power of ten.
        return normalizeToPrice(Number(receipt.groundTruth.value), receipt.groundTruth.decimals);
    } catch {
        return undefined;
    }
}

function groundTruthChecks(
    receipt: Receipt,
    signedGroundTruthValue: bigint,
    refetched: { readonly rawValue: string; readonly normalized: bigint } | undefined,
): Check[] {
    const recordedLabel = "signed ground truth matches the receipt's recorded value";
    const recorded = normalizeRecorded(receipt);
    const checks: Check[] = [
        recorded === undefined
            ? skip(recordedLabel, `unsupported ground-truth kind "${receipt.groundTruth.kind}"`)
            : verdict(
                  recordedLabel,
                  recorded === signedGroundTruthValue,
                  `signed=${signedGroundTruthValue} receipt=${recorded}`,
              ),
    ];

    const refetchLabel = 'ground truth re-fetched from the DA layer matches';
    checks.push(
        refetched === undefined
            ? skip(refetchLabel, 'no DA layer URL configured')
            : verdict(
                  refetchLabel,
                  refetched.rawValue === receipt.groundTruth.value &&
                      refetched.normalized === signedGroundTruthValue,
                  `oracle=${refetched.rawValue}`,
              ),
    );
    return checks;
}

/**
 * Replay one entry's score from its revealed submission.
 *
 * Dispatches through the shared scorer registry, so the code that replays a score is literally
 * the code that produced it. The reference compared the evaluator id to a string literal in three
 * separate files.
 */
function replayScore(
    scorer: Scorer,
    revealed: Record<string, string>,
    endPrice: bigint,
    startPrice: bigint,
    lifetimeSecs: number,
): number {
    const v = scorer({ revealed, endPrice, startPrice, lifetimeSecs });
    // An agent-fault verdict settles as 0, which is what the engine records.
    return v.ok ? v.score : 0;
}

/**
 * The check to report when this build cannot run the scorer.
 *
 * Two reasons, and they mean opposite things. An evaluator whose result is not derivable from
 * public data (a trading return) is a STATED PROPERTY of that evaluator, and calling it a failure
 * would tell a reader something is broken when nothing is. An evaluator this build has never
 * heard of is a real finding, and reporting it as merely skipped would let an unverifiable
 * settlement pass unremarked.
 */
function unreplayable(label: string, evaluatorId: string): Check | undefined {
    const r = replayability(evaluatorId);
    if (r.kind === 'replayable') return undefined;
    if (r.kind === 'not-replayable') {
        return skip(label, `evaluator "${evaluatorId}" is not replayable: ${r.reason}`);
    }
    return make(
        label,
        'fail',
        `this build has no scorer for evaluator "${evaluatorId}" — it may predate or postdate ` +
            'this version of quadra-core, or the settlement may not be genuine',
    );
}

async function recoverOrZero(recover: () => Promise<Address>): Promise<Address> {
    try {
        return await recover();
    } catch {
        // A malformed signature recovers to nothing, which is a failed check rather than a crash.
        return zeroAddress;
    }
}

// --- competitions -------------------------------------------------------------------------------

export interface CompetitionVerifyInput {
    readonly receiptBody: Hex;
    readonly anchoredReceiptHash: Hex;
    readonly signature: Hex;
    readonly signedGroundTruthValue: bigint;
    /** From the settle calldata. `score` is a bigint because the on-chain field is uint64. */
    readonly signedEntries: readonly { readonly agent: Address; readonly score: bigint }[];
    readonly registeredTee: Address;
    readonly registeredImageDigest?: string | undefined;
    readonly chainId: number;
    readonly verifyingContract: Address;
    /** agent (lowercased) -> the on-chain keccak(ciphertext) commitment from submitSealed. */
    readonly commitments: ReadonlyMap<string, Hex>;
    /** Explicitly `| undefined`: the caller passes it through unset when no DA URL is configured. */
    readonly refetchedGroundTruth?:
        | { readonly rawValue: string; readonly normalized: bigint }
        | undefined;
}

/**
 * Verify a COMPETITION settlement. Submissions are revealed in the receipt at settlement, so a
 * full score replay is possible for anyone — this is the fully public case.
 */
export async function verifyCompetition(input: CompetitionVerifyInput): Promise<Check[]> {
    const receipt = parseReceipt(input.receiptBody);
    const checks: Check[] = [
        ...receiptChecks(input.receiptBody, input.anchoredReceiptHash, receipt),
    ];

    const signer = await recoverOrZero(() =>
        recoverTypedDataAddress({
            domain: competitionDomain(input.chainId, input.verifyingContract),
            types: competitionTypes,
            primaryType: 'Settlement',
            message: {
                competitionId: receipt.competitionId,
                receiptHash: input.anchoredReceiptHash,
                groundTruthValue: input.signedGroundTruthValue,
                entries: input.signedEntries.map((e) => ({ agent: e.agent, score: e.score })),
            },
            signature: input.signature,
        }),
    );
    checks.push(
        verdict(
            'EIP-712 signer is the registered TEE',
            signer.toLowerCase() === input.registeredTee.toLowerCase(),
            signer,
        ),
    );

    checks.push(imageDigestCheck(receipt, input.registeredImageDigest));
    checks.push(
        ...groundTruthChecks(receipt, input.signedGroundTruthValue, input.refetchedGroundTruth),
    );

    // Every revealed submission must match the ciphertext committed on chain BEFORE resolution.
    // This is what makes the competition sealed rather than merely private.
    let commitmentsOk = receipt.entries.length > 0;
    for (const e of receipt.entries) {
        const onChain = input.commitments.get(e.agent.toLowerCase());
        if (!onChain || onChain.toLowerCase() !== e.ciphertextHash.toLowerCase()) {
            commitmentsOk = false;
        }
    }
    checks.push(
        verdict(
            'sealed-submission commitments match the receipt',
            commitmentsOk,
            `${receipt.entries.length} entries`,
        ),
    );

    // The signed entry set and the receipt entry set must be the SAME set. The reference only
    // walked the receipt, so an extra entry present in the signature but absent from the receipt
    // would be paid out while never appearing in the audit artifact.
    const receiptAgents = new Set(receipt.entries.map((e) => e.agent.toLowerCase()));
    const signedAgents = new Set(input.signedEntries.map((e) => e.agent.toLowerCase()));
    const sameSet =
        receiptAgents.size === signedAgents.size &&
        receiptAgents.size === receipt.entries.length &&
        [...signedAgents].every((a) => receiptAgents.has(a));
    checks.push(
        verdict(
            'every paid entry appears in the receipt (no extras, no duplicates)',
            sameSet,
            `receipt=${receiptAgents.size} signed=${signedAgents.size}`,
        ),
    );

    // The settled scores must equal a replay of the pure scorer over the revealed submissions.
    const replayLabel = 'replayed scores reproduce the settled scores';
    const blocked = unreplayable(replayLabel, receipt.evaluatorId);
    if (blocked) {
        // Even when the score itself cannot be recomputed, the signed value and the receipt must
        // still agree — that much is checkable for any evaluator, and it catches a settlement
        // that paid out numbers the audit artifact does not contain.
        checks.push(blocked);
        checks.push(
            verdict(
                'settled values match the receipt',
                receipt.entries.every((e) =>
                    input.signedEntries.some(
                        (s) =>
                            s.agent.toLowerCase() === e.agent.toLowerCase() &&
                            s.score === BigInt(e.score),
                    ),
                ),
                `${receipt.entries.length} entries`,
            ),
        );
        return checks;
    }

    const scorer = replayability(receipt.evaluatorId);
    const startValue = BigInt(receipt.startValue);
    let replayOk = receipt.entries.length > 0;
    let replayed = 0;
    if (scorer.kind === 'replayable') {
        for (const e of receipt.entries) {
            const expected = replayScore(
                scorer.scorer,
                e.revealed,
                input.signedGroundTruthValue,
                startValue,
                receipt.lifetimeSecs,
            );
            replayed += 1;
            if (expected !== e.score) replayOk = false;
            const signed = input.signedEntries.find(
                (s) => s.agent.toLowerCase() === e.agent.toLowerCase(),
            );
            if (!signed || signed.score !== BigInt(e.score)) replayOk = false;
        }
    }
    checks.push(verdict(replayLabel, replayOk, `${replayed} entries replayed`));

    return checks;
}

// --- paid jobs ----------------------------------------------------------------------------------

export interface JobVerifyInput {
    readonly receiptBody: Hex;
    readonly anchoredReceiptHash: Hex;
    readonly signature: Hex;
    readonly signedGroundTruthValue: bigint;
    readonly signedScore: number;
    readonly agent: Address;
    readonly registeredTee: Address;
    readonly registeredImageDigest?: string | undefined;
    readonly chainId: number;
    readonly verifyingContract: Address;
    /** The on-chain keccak(ciphertext) commitment from deliver. */
    readonly deliveredHash: Hex;
    /** Explicitly `| undefined`: the caller passes it through unset when no DA URL is configured. */
    readonly refetchedGroundTruth?:
        | { readonly rawValue: string; readonly normalized: bigint }
        | undefined;
    /**
     * ONLY the paying user can supply this — they hold the key that opens their envelope wrap.
     * Without it the score cannot be replayed, by design: a paid result stays private forever.
     */
    readonly revealed?: Record<string, string> | undefined;
}

/**
 * Verify a PAID JOB settlement.
 *
 * Note the deliberate asymmetry: everything except the score replay is publicly checkable,
 * because the result itself is the buyer's private alpha and is never revealed. Anyone can
 * confirm the settlement was produced by the registered TEE against a real oracle price over the
 * exact bytes the agent committed to — without learning what those bytes said.
 */
export async function verifyJob(input: JobVerifyInput): Promise<Check[]> {
    const receipt = parseReceipt(input.receiptBody);
    const checks: Check[] = [
        ...receiptChecks(input.receiptBody, input.anchoredReceiptHash, receipt),
    ];

    const signer = await recoverOrZero(() =>
        recoverTypedDataAddress({
            domain: jobDomain(input.chainId, input.verifyingContract),
            types: jobTypes,
            primaryType: 'JobSettlement',
            message: {
                // A job receipt is a one-entry receipt keyed by jobId; see receipt.ts.
                jobId: receipt.competitionId,
                receiptHash: input.anchoredReceiptHash,
                agent: input.agent,
                score: input.signedScore,
                groundTruthValue: input.signedGroundTruthValue,
            },
            signature: input.signature,
        }),
    );
    checks.push(
        verdict(
            'EIP-712 signer is the registered TEE',
            signer.toLowerCase() === input.registeredTee.toLowerCase(),
            signer,
        ),
    );

    checks.push(imageDigestCheck(receipt, input.registeredImageDigest));
    checks.push(
        ...groundTruthChecks(receipt, input.signedGroundTruthValue, input.refetchedGroundTruth),
    );

    const entry = receipt.entries[0];
    checks.push(
        verdict(
            'delivered-result commitment matches the receipt',
            entry !== undefined &&
                entry.ciphertextHash.toLowerCase() === input.deliveredHash.toLowerCase(),
            input.deliveredHash,
        ),
    );
    checks.push(
        verdict(
            'receipt keeps the paid result private (nothing revealed)',
            entry !== undefined && Object.keys(entry.revealed).length === 0,
        ),
    );
    checks.push(
        verdict(
            'settled score matches the receipt',
            entry !== undefined && entry.score === input.signedScore,
            `score=${input.signedScore}`,
        ),
    );

    const replayLabel = 'replayed score reproduces the settled score';
    const blocked = unreplayable(replayLabel, receipt.evaluatorId);
    if (blocked) {
        checks.push(blocked);
    } else if (input.revealed) {
        const r = replayability(receipt.evaluatorId);
        const expected =
            r.kind === 'replayable'
                ? replayScore(
                      r.scorer,
                      input.revealed,
                      input.signedGroundTruthValue,
                      BigInt(receipt.startValue),
                      receipt.lifetimeSecs,
                  )
                : undefined;
        checks.push(
            verdict(
                `${replayLabel} (using YOUR decrypted result)`,
                expected === input.signedScore,
                `replayed=${expected}`,
            ),
        );
    } else {
        checks.push(
            skip(
                replayLabel,
                'by design — only the paying user can decrypt the result; supply their key to replay',
            ),
        );
    }

    return checks;
}

/** True when nothing failed. Skipped checks are not failures, but they are not passes either. */
export function allPassed(checks: readonly Check[]): boolean {
    return checks.every((c) => c.status !== 'fail');
}

export function countBy(checks: readonly Check[]): Record<CheckStatus, number> {
    return checks.reduce(
        (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
        { pass: 0, fail: 0, skipped: 0 },
    );
}
