/**
 * eip712.ts — the ABI of trust.
 *
 * This is the typed-data contract between the TEE (which signs a settlement), the market
 * contracts (which `ecrecover` the signer and require it to equal the registered TEE wallet), and
 * the verify tool (which recovers it again from calldata). It replaces the Sui engine's BCS
 * IntentMessage + ed25519 with EIP-712 + secp256k1, so the contract verifies for the price of one
 * `ecrecover`.
 *
 * Three places must agree byte for byte:
 *   - this file
 *   - contracts/src/SealedCompetition.sol and contracts/src/JobEscrow.sol
 *   - the recovery path in quadra-verify
 *
 * A mismatch does not fail loudly at the boundary. It produces a signature that recovers to a
 * random address, which the contract rejects as `BadTeeSignature` — indistinguishable from an
 * unregistered TEE, and debugged by reading Solidity string literals against TypeScript ones.
 * Hence the frozen digests asserted at the bottom of this file.
 */

import { hashTypedData, keccak256, toHex, type TypedDataDomain, type Hex, type Address } from 'viem';

// --- Competition settlement (SealedCompetition) -------------------------------------------------

/**
 * The EIP-712 domain. `verifyingContract` binds a signature to ONE SealedCompetition instance, so
 * a settlement signed for one deployment can never be replayed against another — which is what
 * makes redeploying the markets safe. (The FCC path does not have this property; see
 * _migration/KNOWN-CONSTRAINTS.md entry 1.)
 */
export function competitionDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
    return { name: 'SealedCompetition', version: '1', chainId, verifyingContract };
}

/**
 * The typed-data schema. `Entry` is one agent's final ranking value; `Settlement` is the whole
 * payout the TEE attests to, bound to the competition, to the receipt, and to the ground-truth
 * values it was scored against (echoed so the contract can cross-check them against FTSO).
 *
 * `score` is **uint64, not uint8**. The Flare reference used uint8 because it only had scoring
 * competitions. Ours also runs PERFORMANCE competitions, which rank on `PERF_BASE + roi_bps`
 * (around 1e6) and would silently truncate at uint8. Widening it later would have meant a new
 * typehash and a coordinated redeploy, so it was widened before the format was frozen.
 *
 * `feedIds` and `groundTruthValues` are PARALLEL ARRAYS, and the feed ids are inside the signature
 * on purpose. A portfolio competition is scored against several assets; carrying one value meant
 * the contract cross-checked one leg and took the rest on the TEE's word. Signing the feed id
 * beside each value is what lets `FtsoLib.checkGroundTruths` reject a proof for an asset the TEE
 * never named — without it a relayer could swap in a different feed's proof carrying the same
 * number and every on-chain check would still pass.
 */
export const competitionTypes = {
    Entry: [
        { name: 'agent', type: 'address' },
        { name: 'score', type: 'uint64' },
    ],
    Settlement: [
        { name: 'competitionId', type: 'bytes32' },
        { name: 'receiptHash', type: 'bytes32' },
        { name: 'feedIds', type: 'bytes21[]' },
        { name: 'groundTruthValues', type: 'uint256[]' },
        { name: 'entries', type: 'Entry[]' },
    ],
} as const;

export interface SettlementEntry {
    readonly agent: Address;
    /** bigint, because the field is uint64 and a JS number loses precision above 2^53. */
    readonly score: bigint;
}

export interface Settlement {
    readonly competitionId: Hex;
    readonly receiptHash: Hex;
    /** 21-byte FTSO feed ids, index-aligned with `groundTruthValues`. Never empty. */
    readonly feedIds: readonly Hex[];
    readonly groundTruthValues: readonly bigint[];
    readonly entries: readonly SettlementEntry[];
}

/** The EIP-712 digest the TEE signs and SealedCompetition reconstructs. */
export function settlementDigest(
    chainId: number,
    verifyingContract: Address,
    settlement: Settlement,
): Hex {
    return hashTypedData({
        domain: competitionDomain(chainId, verifyingContract),
        types: competitionTypes,
        primaryType: 'Settlement',
        message: {
            competitionId: settlement.competitionId,
            receiptHash: settlement.receiptHash,
            feedIds: [...settlement.feedIds],
            groundTruthValues: [...settlement.groundTruthValues],
            entries: settlement.entries.map((e) => ({ agent: e.agent, score: e.score })),
        },
    });
}

// --- Paid-job settlement (JobEscrow) ------------------------------------------------------------

/**
 * JobEscrow's own domain. The distinct `name` means a job settlement can never be replayed
 * against a SealedCompetition even at the same address, and `verifyingContract` means it cannot
 * be replayed against another JobEscrow.
 */
export function jobDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
    return { name: 'JobEscrow', version: '1', chainId, verifyingContract };
}

/**
 * A paid job is always graded in [0,100] — the range the Passport stores — so `score` stays
 * uint8 here. Only competitions needed the wider ranking value.
 */
export const jobTypes = {
    JobSettlement: [
        { name: 'jobId', type: 'bytes32' },
        { name: 'receiptHash', type: 'bytes32' },
        { name: 'agent', type: 'address' },
        { name: 'score', type: 'uint8' },
        { name: 'groundTruthValue', type: 'uint256' },
    ],
} as const;

export interface JobSettlement {
    readonly jobId: Hex;
    readonly receiptHash: Hex;
    readonly agent: Address;
    readonly score: number;
    readonly groundTruthValue: bigint;
}

/** The EIP-712 digest the TEE signs and JobEscrow reconstructs. */
export function jobSettlementDigest(
    chainId: number,
    verifyingContract: Address,
    settlement: JobSettlement,
): Hex {
    return hashTypedData({
        domain: jobDomain(chainId, verifyingContract),
        types: jobTypes,
        primaryType: 'JobSettlement',
        message: {
            jobId: settlement.jobId,
            receiptHash: settlement.receiptHash,
            agent: settlement.agent,
            score: settlement.score,
            groundTruthValue: settlement.groundTruthValue,
        },
    });
}

// --- Frozen type strings ------------------------------------------------------------------------

/**
 * The exact strings the Solidity `keccak256(...)` constants hash. Exported so the engine, the
 * verifier and the docs can cite one copy rather than each transcribing them.
 */
export const ENTRY_TYPE_STRING = 'Entry(address agent,uint64 score)';
export const SETTLEMENT_TYPE_STRING =
    'Settlement(bytes32 competitionId,bytes32 receiptHash,bytes21[] feedIds,' +
    'uint256[] groundTruthValues,Entry[] entries)' +
    ENTRY_TYPE_STRING;
export const JOB_SETTLEMENT_TYPE_STRING =
    'JobSettlement(bytes32 jobId,bytes32 receiptHash,address agent,uint8 score,uint256 groundTruthValue)';

export const ENTRY_TYPEHASH = keccak256(toHex(ENTRY_TYPE_STRING));
export const SETTLEMENT_TYPEHASH = keccak256(toHex(SETTLEMENT_TYPE_STRING));
export const JOB_SETTLEMENT_TYPEHASH = keccak256(toHex(JOB_SETTLEMENT_TYPE_STRING));

/**
 * The values `cast keccak` produced for the strings above, and the values the deployed contracts
 * compiled. These are frozen: every settlement ever signed recovers against them.
 *
 * Checked at import rather than in a test, because the failure this guards against is an edit to
 * a type string above, and an edit is exactly when the check must fire — including in a build
 * where the tests were not run.
 *
 * `Settlement` WAS UNFROZEN ONCE, deliberately, on 2026-08-11 (BUGS.md 27). It moved from a single
 * `uint256 groundTruthValue` to the `bytes21[] feedIds` / `uint256[] groundTruthValues` pair so a
 * portfolio competition can have every leg cross-checked on chain instead of one. The old value
 * was `0x38d6bb5820f67e522ecb352cea5f9cd630ea0b30e270c72b2da2a4c78b2bb6f8`; it is recorded here
 * because a signature produced against it will not verify against the new markets, and "why does
 * this recover to a random address" is the question that value answers.
 *
 * This was safe to do exactly once, and only because nothing had settled through it yet on a
 * deployment that survives: the change shipped WITH the redeploy that DEPLOYMENT-STATE Gap 4
 * already forced. Doing it again after a real settlement means every past settlement stops
 * verifying. `Entry` and `JobSettlement` did not move.
 */
const FROZEN: ReadonlyArray<readonly [string, Hex, Hex]> = [
    ['Entry', ENTRY_TYPEHASH, '0x78fddf7e955aaa4c2a9ece10c67c52c9310b790f3ead56a2feaf7ad23b4a2ca5'],
    [
        'Settlement',
        SETTLEMENT_TYPEHASH,
        '0x77b51011b97c64b7a8b841b839555bdc619c690ccd5c9b9719d72cb6e4765f9a',
    ],
    [
        'JobSettlement',
        JOB_SETTLEMENT_TYPEHASH,
        '0x770381a966765c6c30090557d050deafb4ad70fda8a813ef501c9f0bd061cf8e',
    ],
];

for (const [name, actual, frozen] of FROZEN) {
    if (actual !== frozen) {
        throw new Error(
            `eip712: the ${name} typehash changed (${actual}, expected ${frozen}). ` +
                'The deployed contracts recover against the frozen value, so every signature ' +
                'produced with this build would be rejected. Revert the type string, or ' +
                'redeploy the markets and update both sides together.',
        );
    }
}
