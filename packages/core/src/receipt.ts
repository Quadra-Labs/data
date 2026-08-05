/**
 * receipt.ts — the audit artifact.
 *
 * Every settlement produces one receipt recording what the TEE decrypted, what ground truth it
 * fetched, which code scored it, and what came out. `keccak(canonical receipt)` is anchored in the
 * settle transaction and bound into the EIP-712 struct; the full body is emitted in
 * `ReceiptPublished`. That is what converts "trust the enclave" into "here is the trail the chain
 * anchored, re-derive it yourself".
 *
 * The paid-job receipt reveals nothing private — only the ciphertext commitment and the score — so
 * a buyer's result stays their alpha while its accuracy becomes public. The competition receipt
 * does reveal submissions, because a competition's whole point is a public leaderboard.
 */

import { keccak256, toHex, type Hex, type Address } from 'viem';

/**
 * The ground truth the scores were measured against. `kind` selects how a verifier re-checks it:
 * an FTSO anchor value carries a voting round (re-fetchable and Merkle-provable), an FDC Web2Json
 * value carries the attestation request and round.
 *
 * Only `ftso-anchor` is produced today. The second arm is declared because the receipt format is
 * frozen by the first settlement that uses it, and adding a variant later would change the shape
 * of a field a verifier already parses.
 */
export type GroundTruth =
    | {
          readonly kind: 'ftso-anchor';
          readonly feedId: Hex;
          readonly votingRoundId: number;
          /** Decimal string of the integer feed value. */
          readonly value: string;
          readonly decimals: number;
      }
    | {
          readonly kind: 'fdc-web2json';
          readonly attestationRequest: Hex;
          readonly votingRoundId: number;
          readonly value: string;
      };

/**
 * One entrant's revealed submission and score. `ciphertextHash` ties back to the on-chain
 * `submitSealed` (or `deliver`) commitment, so a verifier can confirm the revealed plaintext is
 * what was actually committed before the answer was known.
 */
export interface ReceiptEntry {
    readonly agent: Address;
    readonly ciphertextHash: Hex;
    /** The decrypted submission. Empty on a paid job — nothing private is revealed. */
    readonly revealed: Record<string, string>;
    /**
     * A JSON number, not a bigint, because this struct is serialized. Competition ranking values
     * reach ~1e6 (PERF_BASE + roi_bps) and paid-job scores are [0,100]; both are exact integers
     * well below 2^53, so nothing is lost. The signed EIP-712 struct carries the same value as a
     * bigint, which is what `uint64` decodes to.
     */
    readonly score: number;
}

export interface Receipt {
    /**
     * The competition id — or, on the paid-job path, the JOB id. One field, two roles: a job
     * receipt is a one-entry receipt keyed by jobId. Renaming this field would change the
     * canonical bytes and therefore the hash of every settlement ever anchored.
     */
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    /**
     * The TEE code identity — the Confidential Space container image digest bound on-chain in
     * TeeRegistry. A receipt is only trustworthy if this digest is the registered one.
     */
    readonly teeImageDigest: string;
    readonly groundTruth: GroundTruth;
    /** Integer string in the feed's decimals; the tolerance scale the scorer used. */
    readonly startValue: string;
    /**
     * The scored window in seconds. REQUIRED for replay: the price-range scorer sizes its
     * tolerance by sqrt(lifetime), so a verifier cannot re-derive the score without it.
     */
    readonly lifetimeSecs: number;
    readonly entries: readonly ReceiptEntry[];
    /** Unix seconds. Informational — the signature covers the receipt hash, not this directly. */
    readonly resolvedAt: number;
}

/**
 * Deterministic canonical JSON: object keys sorted recursively, no whitespace.
 *
 * This function IS the hash preimage. Two parties holding the same Receipt must produce the same
 * bytes, so nothing here may depend on key insertion order, on `JSON.stringify`'s spacing, or on
 * anything else that varies between engines. Do not "clean this up".
 */
export function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * The canonical receipt as bytes — the `receipt` argument to `settle` / `scoreJob`, which
 * re-check `keccak256(receipt) == receiptHash` before accepting it and then emit it verbatim.
 */
export function receiptBytes(receipt: Receipt): Hex {
    return toHex(canonicalize(receipt));
}

/** The hash anchored on chain and bound into the EIP-712 struct. */
export function receiptHash(receipt: Receipt): Hex {
    return keccak256(receiptBytes(receipt));
}
