/**
 * abis.ts — the contract surface the read layer consults.
 *
 * Written as human-readable signatures rather than JSON so a reader can check them against the
 * Solidity by eye. They are verified against the compiled artifacts in `contracts/abi/` by test,
 * because a hand-written ABI that drifts from its contract fails at runtime with an opaque decode
 * error rather than at build time.
 *
 * This is deliberately NOT the same file as `quadra-verify`'s ABI. That one is trimmed to the
 * minimum a verifier needs, so a reader can confirm at a glance what the audit consults; this one
 * covers everything the indexer ingests. Two files with two different jobs, and the verifier's
 * being short is the point of it.
 */

import { parseAbi } from 'viem';

export const jobEscrowAbi = parseAbi([
    // reads
    'function jobs(bytes32) view returns (address user, address agent, bytes32 category, uint256 escrow, uint64 deliveryDeadline, uint64 lifetimeEnd, bool delivered, bool released, bool scored)',
    'function deliveredHash(bytes32) view returns (bytes32)',
    'function scoredReceiptHash(bytes32) view returns (bytes32)',
    'function feeBps() view returns (uint16)',
    'function token() view returns (address)',
    // events
    'event JobPaid(bytes32 indexed jobId, address indexed user, address indexed agent, string evaluatorId, uint256 cost, uint64 deliveryDeadline, uint64 lifetimeEnd, bytes userPubKey, bytes params)',
    'event Delivered(bytes32 indexed jobId, address indexed agent, bytes32 ciphertextHash)',
    'event PaymentReleased(bytes32 indexed jobId, address indexed agent, uint256 agentAmount, uint256 fee)',
    'event JobNotDelivered(bytes32 indexed jobId, address indexed agent, address indexed user, uint256 refundAmount)',
    'event JobScored(bytes32 indexed jobId, address indexed agent, uint8 score, bytes32 receiptHash)',
    'event ReceiptPublished(bytes32 indexed jobId, bytes receipt)',
    'event PassportRecordFailed(bytes32 indexed jobId, address indexed agent)',
]);

export const sealedCompetitionAbi = parseAbi([
    // reads. Note the auto-generated getter omits `splitPct` — Solidity struct getters skip
    // dynamic arrays — which is why `getSplit` exists as a separate call.
    'function competitions(bytes32) view returns (string evaluatorId, bytes32 category, uint8 kind, uint256 stake, uint256 seedPrize, uint256 stakedTotal, uint256 prizePool, uint64 resolveAt, uint64 threshold, bool exists, bool settled, bool cancelled, address creator)',
    'function getSplit(bytes32 competitionId) view returns (uint16[])',
    'function submissions(bytes32, address) view returns (bytes32)',
    'function joined(bytes32, address) view returns (bool)',
    'function staked(bytes32, address) view returns (uint256)',
    'function owed(address) view returns (uint256)',
    'function settledReceiptHash(bytes32) view returns (bytes32)',
    'function KIND_SCORING() view returns (uint8)',
    'function KIND_PERFORMANCE() view returns (uint8)',
    'function PERF_BASE() view returns (uint64)',
    // events
    'event CompetitionCreated(bytes32 indexed competitionId, string evaluatorId, uint8 kind, uint256 stake, uint256 seedPrize, uint64 resolveAt, uint64 threshold, address indexed creator)',
    'event Joined(bytes32 indexed competitionId, address indexed agent, uint256 stake)',
    'event Submitted(bytes32 indexed competitionId, address indexed agent, bytes32 ciphertextHash)',
    'event PrizeAwarded(bytes32 indexed competitionId, address indexed agent, uint256 rank, uint256 amount)',
    'event Settled(bytes32 indexed competitionId, bytes32 receiptHash, uint256 winners, uint256 totalPaid)',
    'event Cancelled(bytes32 indexed competitionId, uint256 seedReturned)',
    'event StakeWithdrawn(bytes32 indexed competitionId, address indexed agent, uint256 amount)',
    'event PrizeClaimed(address indexed agent, uint256 amount)',
    'event ReceiptPublished(bytes32 indexed competitionId, bytes receipt)',
]);

export const passportAbi = parseAbi([
    'function getTrack(address agent, bytes32 category) view returns (uint32 scored, uint64 totalScore, uint8 best)',
    'function overall(address agent, bytes32 category) view returns (uint256)',
    'function rank(address agent, bytes32 category) view returns (uint256)',
    // Paginated, unlike the Flare reference's unbounded `agentsIn(category)`: the list grows
    // without limit as agents join, and an unbounded return eventually exceeds the node's
    // eth_call budget, at which point the leaderboard simply stops loading.
    'function agentsIn(bytes32 category, uint256 offset, uint256 limit) view returns (address[] page)',
    'function agentCountIn(bytes32 category) view returns (uint256)',
    'function MAX_SCORE() view returns (uint8)',
    // Carries `sourceId` — the jobId or competitionId the score came from — so a reputation can be
    // traced back to the settlement that produced it. The reference's event could not be.
    'event Recorded(address indexed agent, bytes32 indexed category, bytes32 indexed sourceId, uint8 score)',
    'event RecorderSet(address indexed recorder, bool allowed)',
]);

export const teeRegistryAbi = parseAbi([
    'function activeTeeWallet() view returns (address)',
    'function activeTeePublicKey() view returns (bytes)',
    'function expectedImageDigest() view returns (string)',
    'function fccMode() view returns (bool)',
    'function isTee(address who) view returns (bool)',
    'event TeeRegistered(address indexed teeWallet, string imageDigest)',
    'event FccTeeRegistered(address indexed teeMachine, uint256 extensionId)',
]);
