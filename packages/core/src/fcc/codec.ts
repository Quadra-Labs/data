/**
 * codec.ts — the three Flare Confidential Compute result payloads, as TypeScript.
 *
 * When a settlement travels the FCC path, everything the enclave decided is inside ONE
 * abi-encoded `bytes` argument: `scoreJobFromTee(resultData, ...)` and
 * `settleFromTee(resultData, ...)`. The score, the ground-truth value and the entry list are not
 * named calldata arguments the way they are on the EIP-712 path, so anything that reads a
 * settlement — the verifier today, the evaluation engine when it starts producing them — has to
 * agree with the Solidity on this layout byte for byte.
 *
 * `abi.decode` on a mismatched layout does not fail politely. It reverts with no reason string,
 * or worse, succeeds and yields plausible garbage. So the layouts live HERE, in one place, rather
 * than being re-declared by each consumer:
 *
 *   - `contracts/src/JobEscrow.sol`            — `TeeValidation`, `TeeJobScore`
 *   - `contracts/src/SealedCompetition.sol`    — `TeeCompetitionSettlement`
 *   - `contracts/src/interfaces/IFtsoFeedVerifier.sol` — `FeedDataWithProof`
 *
 * Pure abi coding, no I/O, so this is safe for the enclave image to compile in. It is exposed as
 * its own `quadra-core/fcc` subpath rather than from the root, so the existing entrypoints keep
 * exactly the surface they have today.
 *
 * ONE FIELD IS EASY TO GET WRONG. A competition entry's `score` is **uint64**, not the uint8 a
 * scoring-only market would use, because a PERFORMANCE competition ranks on `PERF_BASE + roi_bps`
 * (around 1e6). The Flare prototype declares it uint8; copying that would misalign every field
 * after it while still decoding "successfully".
 */

import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from 'viem';

// --- shared: the FTSO anchor-feed proof ---------------------------------------------------------

/**
 * `IFtsoFeedVerifier.FeedDataWithProof`. Rides inside both settlement payloads.
 *
 * Note `turnoutBPS`: the Solidity struct spells it that way while the live DA layer answers with
 * `turnoutBIPS`. That mismatch is handled where the JSON is parsed (`groundTruth.ts`); by the time
 * a value reaches this codec it is positional abi data and the name is only documentation.
 */
const FEED_DATA_WITH_PROOF = {
    name: 'proof',
    type: 'tuple',
    components: [
        { name: 'proof', type: 'bytes32[]' },
        {
            name: 'body',
            type: 'tuple',
            components: [
                { name: 'votingRoundId', type: 'uint32' },
                { name: 'id', type: 'bytes21' },
                { name: 'value', type: 'int32' },
                { name: 'turnoutBPS', type: 'uint16' },
                { name: 'decimals', type: 'int8' },
            ],
        },
    ],
} as const;

/** The same tuple as an ARRAY, for the competition settlement's per-asset proofs. */
const FEED_DATA_WITH_PROOF_ARRAY = {
    name: 'proofs',
    type: 'tuple[]',
    components: [
        { name: 'proof', type: 'bytes32[]' },
        {
            name: 'body',
            type: 'tuple',
            components: [
                { name: 'votingRoundId', type: 'uint32' },
                { name: 'id', type: 'bytes21' },
                { name: 'value', type: 'int32' },
                { name: 'turnoutBPS', type: 'uint16' },
                { name: 'decimals', type: 'int8' },
            ],
        },
    ],
} as const;

export interface FeedData {
    readonly votingRoundId: number;
    readonly id: Hex;
    readonly value: number;
    readonly turnoutBPS: number;
    readonly decimals: number;
}

export interface FeedDataWithProof {
    readonly proof: readonly Hex[];
    readonly body: FeedData;
}

// --- TeeValidation (JobEscrow) ------------------------------------------------------------------

const TEE_VALIDATION = [
    {
        type: 'tuple',
        components: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'deliveryHash', type: 'bytes32' },
            { name: 'valid', type: 'bool' },
            { name: 'reason', type: 'string' },
        ],
    },
] as const;

/** What the enclave returns for EVALUATION/VALIDATE. */
export interface TeeValidation {
    readonly jobId: Hex;
    /** The ciphertext commitment that was actually judged, binding the verdict to those bytes. */
    readonly deliveryHash: Hex;
    readonly valid: boolean;
    readonly reason: string;
}

// --- TeeJobScore (JobEscrow) --------------------------------------------------------------------

const TEE_JOB_SCORE = [
    {
        type: 'tuple',
        components: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'receiptHash', type: 'bytes32' },
            { name: 'score', type: 'uint8' },
            { name: 'groundTruthValue', type: 'uint256' },
            { name: 'receipt', type: 'bytes' },
            FEED_DATA_WITH_PROOF,
        ],
    },
] as const;

/** What the enclave returns for EVALUATION/SCORE_JOB. `score` is uint8: a job is graded [0,100]. */
export interface TeeJobScore {
    readonly jobId: Hex;
    readonly receiptHash: Hex;
    readonly score: number;
    readonly groundTruthValue: bigint;
    readonly receipt: Hex;
    readonly proof: FeedDataWithProof;
}

// --- TeeCompetitionSettlement (SealedCompetition) -----------------------------------------------

const TEE_COMPETITION_SETTLEMENT = [
    {
        type: 'tuple',
        components: [
            { name: 'competitionId', type: 'bytes32' },
            { name: 'receiptHash', type: 'bytes32' },
            // Parallel arrays, index-aligned with each other AND with `proofs`. A portfolio
            // competition is scored against several assets; carrying one value left every leg but
            // the first attested by the TEE signature alone.
            { name: 'feedIds', type: 'bytes21[]' },
            { name: 'groundTruthValues', type: 'uint256[]' },
            {
                name: 'entries',
                type: 'tuple[]',
                components: [
                    { name: 'agent', type: 'address' },
                    // uint64, NOT uint8 — see the header note.
                    { name: 'score', type: 'uint64' },
                ],
            },
            { name: 'receipt', type: 'bytes' },
            FEED_DATA_WITH_PROOF_ARRAY,
        ],
    },
] as const;

export interface TeeEntry {
    readonly agent: Address;
    readonly score: bigint;
}

/** What the enclave returns for EVALUATION/SETTLE_COMP. */
export interface TeeCompetitionSettlement {
    readonly competitionId: Hex;
    readonly receiptHash: Hex;
    /** 21-byte FTSO feed ids, index-aligned with `groundTruthValues` and `proofs`. Never empty. */
    readonly feedIds: readonly Hex[];
    readonly groundTruthValues: readonly bigint[];
    readonly entries: readonly TeeEntry[];
    readonly receipt: Hex;
    readonly proofs: readonly FeedDataWithProof[];
}

// --- decode -------------------------------------------------------------------------------------
//
// Each decoder throws a NAMED error rather than letting viem's generic "position out of bounds"
// surface. A caller that cannot decode a blob needs to distinguish "this build's layout does not
// match the chain's" from "the RPC returned junk", and viem's message does not say which.

function fail(what: string, err: unknown): never {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
        `fcc: could not decode the TEE result as ${what} — this build's struct layout does not ` +
            `match the one the contract was compiled with (${detail})`,
    );
}

export function decodeTeeValidation(resultData: Hex): TeeValidation {
    try {
        const [v] = decodeAbiParameters(TEE_VALIDATION, resultData);
        return v as TeeValidation;
    } catch (err) {
        return fail('TeeValidation', err);
    }
}

export function decodeTeeJobScore(resultData: Hex): TeeJobScore {
    try {
        const [v] = decodeAbiParameters(TEE_JOB_SCORE, resultData);
        return v as TeeJobScore;
    } catch (err) {
        return fail('TeeJobScore', err);
    }
}

export function decodeTeeCompetitionSettlement(resultData: Hex): TeeCompetitionSettlement {
    try {
        const [v] = decodeAbiParameters(TEE_COMPETITION_SETTLEMENT, resultData);
        return v as TeeCompetitionSettlement;
    } catch (err) {
        return fail('TeeCompetitionSettlement', err);
    }
}

// --- encode -------------------------------------------------------------------------------------
//
// The encoders exist so the producer (the evaluation engine, MIGRATION-PLAN step 9) and the
// consumer (the verifier, today) share one declaration of the layout. Two files that happen to
// agree is a coincidence waiting to end; one file cannot drift from itself.

export function encodeTeeValidation(value: TeeValidation): Hex {
    return encodeAbiParameters(TEE_VALIDATION, [value]);
}

export function encodeTeeJobScore(value: TeeJobScore): Hex {
    return encodeAbiParameters(TEE_JOB_SCORE, [value]);
}

export function encodeTeeCompetitionSettlement(value: TeeCompetitionSettlement): Hex {
    return encodeAbiParameters(TEE_COMPETITION_SETTLEMENT, [value]);
}
