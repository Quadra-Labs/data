/**
 * abis.ts — the minimal contract surface `verify` needs.
 *
 * Hand-trimmed rather than imported from Foundry's build output, on purpose. This file is meant to
 * be READ: it is the complete list of what the verifier looks at, and a reader can confirm at a
 * glance that it consults contract storage and events and nothing else. A 2,000-line generated ABI
 * would hide that.
 *
 * The cost is that it can rot. If a contract event gains a field, this file must follow, or the
 * decode fails loudly (viem checks the selector, so a mismatch is not silent).
 */

import type { Abi } from 'viem';

/** The FtsoV2 proof tuple, as it appears in the settlement calldata. */
const feedDataWithProof = {
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

export const jobEscrowVerifyAbi = [
    // --- storage the verifier re-reads rather than trusting a log -------------------------------
    {
        type: 'function',
        name: 'scoredReceiptHash',
        stateMutability: 'view',
        inputs: [{ name: '', type: 'bytes32' }],
        outputs: [{ name: '', type: 'bytes32' }],
    },
    {
        type: 'function',
        name: 'deliveredHash',
        stateMutability: 'view',
        inputs: [{ name: '', type: 'bytes32' }],
        outputs: [{ name: '', type: 'bytes32' }],
    },
    // --- the calldata the settlement travelled in ------------------------------------------------
    {
        type: 'function',
        name: 'scoreJob',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'receiptHash', type: 'bytes32' },
            { name: 'score', type: 'uint8' },
            { name: 'groundTruthValue', type: 'uint256' },
            { name: 'signature', type: 'bytes' },
            feedDataWithProof,
            { name: 'receipt', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        // The Flare Confidential Compute path. Recognized so an FCC settlement reports honestly
        // instead of failing to decode; its TEE_ACTION_RESULT signature is not EIP-712.
        type: 'function',
        name: 'scoreJobFromTee',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'resultData', type: 'bytes' },
            { name: 'actionId', type: 'bytes32' },
            { name: 'submissionTag', type: 'string' },
            { name: 'status', type: 'uint8' },
            { name: 'signature', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        type: 'function',
        name: 'deliver',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'ciphertext', type: 'bytes' },
        ],
        outputs: [],
    },
    // --- events ----------------------------------------------------------------------------------
    {
        type: 'event',
        name: 'ReceiptPublished',
        inputs: [
            { name: 'jobId', type: 'bytes32', indexed: true },
            { name: 'receipt', type: 'bytes', indexed: false },
        ],
    },
    {
        type: 'event',
        name: 'JobScored',
        inputs: [
            { name: 'jobId', type: 'bytes32', indexed: true },
            { name: 'agent', type: 'address', indexed: true },
            { name: 'score', type: 'uint8', indexed: false },
            { name: 'receiptHash', type: 'bytes32', indexed: false },
        ],
    },
    {
        type: 'event',
        name: 'Delivered',
        inputs: [
            { name: 'jobId', type: 'bytes32', indexed: true },
            { name: 'agent', type: 'address', indexed: true },
            { name: 'ciphertextHash', type: 'bytes32', indexed: false },
        ],
    },
] as const satisfies Abi;

export const sealedCompetitionVerifyAbi = [
    {
        type: 'function',
        name: 'settledReceiptHash',
        stateMutability: 'view',
        inputs: [{ name: '', type: 'bytes32' }],
        outputs: [{ name: '', type: 'bytes32' }],
    },
    {
        type: 'function',
        name: 'submissions',
        stateMutability: 'view',
        inputs: [
            { name: '', type: 'bytes32' },
            { name: '', type: 'address' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
    },
    {
        type: 'function',
        name: 'settle',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'competitionId', type: 'bytes32' },
            { name: 'receiptHash', type: 'bytes32' },
            { name: 'groundTruthValue', type: 'uint256' },
            {
                name: 'entries',
                type: 'tuple[]',
                components: [
                    { name: 'agent', type: 'address' },
                    // uint64, not uint8: PERFORMANCE competitions rank on PERF_BASE + roi_bps.
                    { name: 'score', type: 'uint64' },
                ],
            },
            { name: 'signature', type: 'bytes' },
            feedDataWithProof,
            { name: 'receipt', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        type: 'function',
        name: 'settleFromTee',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'resultData', type: 'bytes' },
            { name: 'actionId', type: 'bytes32' },
            { name: 'submissionTag', type: 'string' },
            { name: 'status', type: 'uint8' },
            { name: 'signature', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        type: 'event',
        name: 'ReceiptPublished',
        inputs: [
            { name: 'competitionId', type: 'bytes32', indexed: true },
            { name: 'receipt', type: 'bytes', indexed: false },
        ],
    },
] as const satisfies Abi;

export const teeRegistryVerifyAbi = [
    {
        type: 'function',
        name: 'activeTeeWallet',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'address' }],
    },
    {
        // The container image digest the receipt must name. Without this the receipt's claimed
        // code identity is unchecked.
        type: 'function',
        name: 'expectedImageDigest',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'string' }],
    },
] as const satisfies Abi;
