/**
 * fetch.ts — pull everything `verify` needs off the chain.
 *
 * Nothing here trusts the operator. The receipt body comes from the settlement's own event, the
 * signature from the settle transaction's calldata, the commitments from contract storage, and the
 * TEE identity from the registry. In particular the delivered ciphertext is recovered from
 * CALLDATA, never from an index — a verifier that read it from `quadra-data` would be trusting the
 * very thing it is auditing.
 */

import {
    createPublicClient,
    http as viemHttp,
    decodeFunctionData,
    defineChain,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem';
import { getLogsChunked } from 'quadra-core';
import type { SettlementPath } from 'quadra-core/verify';

import { jobEscrowVerifyAbi, sealedCompetitionVerifyAbi, teeRegistryVerifyAbi } from './abis.js';

export interface VerifyChainConfig {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly jobEscrow?: Address | undefined;
    readonly sealedCompetition?: Address | undefined;
    readonly teeRegistry: Address;
    readonly fromBlock?: bigint | undefined;
    /**
     * Newest block to scan back from. Bounding this is what makes verifying an OLD settlement
     * cheap: the scan walks backwards from here, so pointing it at the settle block turns a
     * multi-thousand window walk into a handful of requests. Purely a search hint — every check
     * still re-derives from what it finds.
     */
    readonly toBlock?: bigint | undefined;
    /** Print scan progress. The CLI does; library callers stay quiet. */
    readonly verbose?: boolean | undefined;
}

/** The block a transaction landed in — resolves `--tx <settleTx>` into a scan bound. */
export async function blockOfTx(config: VerifyChainConfig, hash: Hex): Promise<bigint> {
    const receipt = await makeClient(config).getTransactionReceipt({ hash });
    return receipt.blockNumber;
}

/** What a settlement transaction committed to, recovered from its calldata and events. */
export interface FetchedSettlement {
    readonly receiptBody: Hex;
    readonly anchoredReceiptHash: Hex;
    /** Empty on the FCC path, where the signature is not EIP-712 typed data. */
    readonly signature: Hex;
    readonly settlementPath: SettlementPath;
    readonly groundTruthValue: bigint;
    /** Competition only: the per-agent ranking values the TEE signed. */
    readonly entries: readonly { readonly agent: Address; readonly score: bigint }[];
    /** Job only. */
    readonly score?: number;
    readonly agent?: Address;
    readonly txHash: Hex;
}

function makeClient(config: VerifyChainConfig): PublicClient {
    // A synthetic chain definition, so the tool works against any EVM chain id without importing
    // a chain list it would then have to keep current.
    const chain = defineChain({
        id: config.chainId,
        name: `chain-${config.chainId}`,
        nativeCurrency: { name: 'Native', symbol: 'NAT', decimals: 18 },
        rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    return createPublicClient({ chain, transport: viemHttp(config.rpcUrl) }) as PublicClient;
}

export interface RegisteredTee {
    readonly wallet: Address;
    readonly imageDigest: string;
}

export interface VerifyFetcher {
    registeredTee(): Promise<RegisteredTee>;
    fetchJobSettlement(jobId: Hex): Promise<FetchedSettlement>;
    fetchCompetitionSettlement(competitionId: Hex): Promise<FetchedSettlement>;
    deliveredHash(jobId: Hex): Promise<Hex>;
    submissionHash(competitionId: Hex, agent: Address): Promise<Hex>;
    /** The delivered ciphertext, from the deliver tx calldata. Only the buyer's key opens it. */
    deliveredCiphertext(jobId: Hex): Promise<Hex>;
}

const isZeroHash = (h: Hex): boolean => /^0x0*$/.test(h);

export function makeVerifyFetcher(config: VerifyChainConfig): VerifyFetcher {
    const client = makeClient(config);
    const fromBlock = config.fromBlock ?? 0n;

    const scan = <T>(fetch: (from: bigint, to: bigint) => Promise<readonly T[]>): Promise<T[]> =>
        getLogsChunked({
            client,
            fromBlock,
            stopAtFirstHit: true,
            fetch,
            ...(config.toBlock !== undefined ? { toBlock: config.toBlock } : {}),
            ...(config.verbose
                ? {
                      onProgress: (scanned: number, block: bigint) => {
                          if (scanned % 25 === 0) {
                              console.log(`  ...scanned ${scanned} windows (at block ${block})`);
                          }
                      },
                  }
                : {}),
        });

    function requireJobEscrow(): Address {
        if (!config.jobEscrow) throw new Error('verify: no JobEscrow address configured');
        return config.jobEscrow;
    }
    function requireCompetition(): Address {
        if (!config.sealedCompetition) {
            throw new Error('verify: no SealedCompetition address configured');
        }
        return config.sealedCompetition;
    }

    return {
        async registeredTee() {
            const [wallet, imageDigest] = await Promise.all([
                client.readContract({
                    address: config.teeRegistry,
                    abi: teeRegistryVerifyAbi,
                    functionName: 'activeTeeWallet',
                }),
                client
                    .readContract({
                        address: config.teeRegistry,
                        abi: teeRegistryVerifyAbi,
                        functionName: 'expectedImageDigest',
                    })
                    // An older registry may not expose it; that degrades the image check to
                    // skipped rather than breaking the whole run.
                    .catch(() => ''),
            ]);
            return { wallet, imageDigest };
        },

        async fetchJobSettlement(jobId) {
            const address = requireJobEscrow();
            // ONE cheap read before any scan. The receipt hash is anchored in the same transaction
            // that emits the receipt, so a zero here means the job was never scored — and scanning
            // for a log that does not exist walks the entire chain in 30-block windows, thousands
            // of requests, only to fail. Public RPCs rate-limit that long before it finishes.
            const anchored = await client.readContract({
                address,
                abi: jobEscrowVerifyAbi,
                functionName: 'scoredReceiptHash',
                args: [jobId],
            });
            if (isZeroHash(anchored)) {
                throw new Error(
                    `verify: job ${jobId} has not been scored yet — the evaluation engine settles ` +
                        "it at the job's lifetime end, plus a short wait for the FTSO round to " +
                        'finalize. Try again then.',
                );
            }

            const receiptLogs = await scan((from, to) =>
                client.getContractEvents({
                    address,
                    abi: jobEscrowVerifyAbi,
                    eventName: 'ReceiptPublished',
                    args: { jobId },
                    fromBlock: from,
                    toBlock: to,
                }),
            );
            const receiptLog = receiptLogs.at(-1);
            if (!receiptLog?.args.receipt) {
                throw new Error(`verify: no ReceiptPublished log found for job ${jobId}`);
            }

            const tx = await client.getTransaction({ hash: receiptLog.transactionHash });
            const decoded = decodeFunctionData({ abi: jobEscrowVerifyAbi, data: tx.input });

            const settledLogs = await scan((from, to) =>
                client.getContractEvents({
                    address,
                    abi: jobEscrowVerifyAbi,
                    eventName: 'JobScored',
                    args: { jobId },
                    fromBlock: from,
                    toBlock: to,
                }),
            );
            const scoredLog = settledLogs.at(-1);
            const common = {
                receiptBody: receiptLog.args.receipt,
                anchoredReceiptHash: anchored,
                txHash: receiptLog.transactionHash,
                entries: [],
                ...(scoredLog?.args.agent ? { agent: scoredLog.args.agent } : {}),
            };

            if (decoded.functionName === 'scoreJob') {
                const [, , score, groundTruthValue, signature] = decoded.args;
                return {
                    ...common,
                    signature,
                    settlementPath: 'eip712',
                    groundTruthValue,
                    score,
                };
            }
            if (decoded.functionName === 'scoreJobFromTee') {
                // The ground truth and score are inside the abi-encoded TEE result blob rather
                // than in named arguments, so read them from the event and the receipt instead.
                return {
                    ...common,
                    signature: '0x',
                    settlementPath: 'fcc',
                    groundTruthValue: 0n,
                    ...(scoredLog?.args.score !== undefined ? { score: scoredLog.args.score } : {}),
                };
            }
            throw new Error(
                `verify: the receipt for job ${jobId} was published by "${decoded.functionName}", ` +
                    'which is not a settlement entrypoint this tool understands',
            );
        },

        async fetchCompetitionSettlement(competitionId) {
            const address = requireCompetition();
            const anchored = await client.readContract({
                address,
                abi: sealedCompetitionVerifyAbi,
                functionName: 'settledReceiptHash',
                args: [competitionId],
            });
            if (isZeroHash(anchored)) {
                throw new Error(
                    `verify: competition ${competitionId} has not been settled yet — the ` +
                        'evaluation engine settles it after resolveAt. Try again then.',
                );
            }

            const receiptLogs = await scan((from, to) =>
                client.getContractEvents({
                    address,
                    abi: sealedCompetitionVerifyAbi,
                    eventName: 'ReceiptPublished',
                    args: { competitionId },
                    fromBlock: from,
                    toBlock: to,
                }),
            );
            const receiptLog = receiptLogs.at(-1);
            if (!receiptLog?.args.receipt) {
                throw new Error(
                    `verify: no ReceiptPublished log found for competition ${competitionId}`,
                );
            }

            const tx = await client.getTransaction({ hash: receiptLog.transactionHash });
            const decoded = decodeFunctionData({
                abi: sealedCompetitionVerifyAbi,
                data: tx.input,
            });
            const common = {
                receiptBody: receiptLog.args.receipt,
                anchoredReceiptHash: anchored,
                txHash: receiptLog.transactionHash,
            };

            if (decoded.functionName === 'settle') {
                const [, , groundTruthValue, entries, signature] = decoded.args;
                return {
                    ...common,
                    signature,
                    settlementPath: 'eip712',
                    groundTruthValue,
                    entries: entries.map((e) => ({ agent: e.agent, score: e.score })),
                };
            }
            if (decoded.functionName === 'settleFromTee') {
                return {
                    ...common,
                    signature: '0x',
                    settlementPath: 'fcc',
                    groundTruthValue: 0n,
                    entries: [],
                };
            }
            throw new Error(
                `verify: the receipt for competition ${competitionId} was published by ` +
                    `"${decoded.functionName}", which is not a settlement entrypoint this tool ` +
                    'understands',
            );
        },

        async deliveredHash(jobId) {
            return client.readContract({
                address: requireJobEscrow(),
                abi: jobEscrowVerifyAbi,
                functionName: 'deliveredHash',
                args: [jobId],
            });
        },

        async submissionHash(competitionId, agent) {
            return client.readContract({
                address: requireCompetition(),
                abi: sealedCompetitionVerifyAbi,
                functionName: 'submissions',
                args: [competitionId, agent],
            });
        },

        async deliveredCiphertext(jobId) {
            const logs = await scan((from, to) =>
                client.getContractEvents({
                    address: requireJobEscrow(),
                    abi: jobEscrowVerifyAbi,
                    eventName: 'Delivered',
                    args: { jobId },
                    fromBlock: from,
                    toBlock: to,
                }),
            );
            const last = logs.at(-1);
            if (!last) throw new Error(`verify: no Delivered log found for job ${jobId}`);
            const tx = await client.getTransaction({ hash: last.transactionHash });
            const decoded = decodeFunctionData({ abi: jobEscrowVerifyAbi, data: tx.input });
            if (decoded.functionName !== 'deliver') {
                throw new Error(
                    `verify: the delivery for job ${jobId} came from "${decoded.functionName}", ` +
                        'not deliver — the ciphertext cannot be recovered from this transaction',
                );
            }
            return decoded.args[1];
        },
    };
}
