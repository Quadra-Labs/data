/**
 * verify.ts — the replay CLI.
 *
 * Given a job or competition id it refetches the settlement from chain and independently
 * re-derives the outcome WITHOUT trusting the operator: the receipt body published on chain
 * hashes to the anchored hash, the signature recovers to the registered TEE, the receipt names
 * the registered image, the sealed commitments match what was locked in before resolution, the
 * ground truth re-fetched from Flare's DA layer matches, and replaying the scorer reproduces
 * every settled score.
 *
 * The two markets differ in ONE way, deliberately: a competition reveals its submissions at
 * settlement so anyone can replay the scores, while a paid job never reveals the result, so only
 * the paying buyer can. Everything else is public in both.
 */

import { pathToFileURL } from 'node:url';

import { openEnvelope } from 'quadra-core';
import { fetchGroundTruth, normalizeToPrice, COSTON2_DA_URL } from 'quadra-core/ground-truth';
import {
    verifyJob,
    verifyCompetition,
    parseReceipt,
    allPassed,
    countBy,
    type Check,
} from 'quadra-core/verify';
import { privateKeyToAccount } from 'viem/accounts';
import { zeroAddress, type Address, type Hex } from 'viem';

import { loadDeployment } from 'quadra-core/deployments';

import { makeVerifyFetcher, blockOfTx, type VerifyChainConfig } from './fetch.js';

export interface VerifyOptions extends VerifyChainConfig {
    /** Flare DA layer base URL. Omitted, the oracle re-fetch check reports as skipped. */
    readonly daBaseUrl?: string | undefined;
    readonly daApiKey?: string | undefined;
    /** The paying buyer's key — enables the private score replay for a paid job. */
    readonly userPrivateKey?: Hex | undefined;
}

async function refetchGroundTruth(
    opts: VerifyOptions,
    receiptBody: Hex,
): Promise<{ rawValue: string; normalized: bigint } | undefined> {
    if (!opts.daBaseUrl) return undefined;
    const receipt = parseReceipt(receiptBody);
    if (receipt.groundTruth.kind !== 'ftso-anchor') return undefined;
    try {
        const g = await fetchGroundTruth({
            daBaseUrl: opts.daBaseUrl,
            feedId: receipt.groundTruth.feedId,
            votingRoundId: receipt.groundTruth.votingRoundId,
            apiKey: opts.daApiKey,
        });
        return {
            rawValue: String(g.feed.body.value),
            normalized: normalizeToPrice(g.feed.body.value, g.feed.body.decimals),
        };
    } catch {
        // An unreachable DA layer must not abort the run: every other check still stands, and the
        // oracle check reports as skipped rather than as a failure of the settlement.
        return undefined;
    }
}

/** Verify a PAID JOB settlement end to end. */
export async function verifyJobById(jobId: Hex, opts: VerifyOptions): Promise<Check[]> {
    if (!opts.jobEscrow) throw new Error('verify: no JobEscrow address configured');
    const fetcher = makeVerifyFetcher(opts);
    const [settlement, tee] = await Promise.all([
        fetcher.fetchJobSettlement(jobId),
        fetcher.registeredTee(),
    ]);
    const deliveredHash = await fetcher.deliveredHash(jobId);
    const refetchedGroundTruth = await refetchGroundTruth(opts, settlement.receiptBody);

    // If the caller is the paying buyer, decrypt their own result so the score can be replayed.
    let revealed: Record<string, string> | undefined;
    if (opts.userPrivateKey) {
        try {
            revealed = openEnvelope(
                opts.userPrivateKey,
                await fetcher.deliveredCiphertext(jobId),
            );
        } catch {
            revealed = undefined;
        }
    }

    return verifyJob({
        receiptBody: settlement.receiptBody,
        anchoredReceiptHash: settlement.anchoredReceiptHash,
        signature: settlement.signature,
        settlementPath: settlement.settlementPath,
        signedGroundTruthValue: settlement.groundTruthValue,
        signedScore: settlement.score ?? 0,
        agent: settlement.agent ?? zeroAddress,
        registeredTee: tee.wallet,
        registeredImageDigest: tee.imageDigest,
        chainId: opts.chainId,
        verifyingContract: opts.jobEscrow,
        deliveredHash,
        refetchedGroundTruth,
        revealed,
    });
}

/** Verify a COMPETITION settlement end to end. */
export async function verifyCompetitionById(
    competitionId: Hex,
    opts: VerifyOptions,
): Promise<Check[]> {
    if (!opts.sealedCompetition) throw new Error('verify: no SealedCompetition address configured');
    const fetcher = makeVerifyFetcher(opts);
    const [settlement, tee] = await Promise.all([
        fetcher.fetchCompetitionSettlement(competitionId),
        fetcher.registeredTee(),
    ]);
    const receipt = parseReceipt(settlement.receiptBody);

    const commitments = new Map<string, Hex>();
    for (const e of receipt.entries) {
        commitments.set(
            e.agent.toLowerCase(),
            await fetcher.submissionHash(competitionId, e.agent),
        );
    }
    const refetchedGroundTruth = await refetchGroundTruth(opts, settlement.receiptBody);

    return verifyCompetition({
        receiptBody: settlement.receiptBody,
        anchoredReceiptHash: settlement.anchoredReceiptHash,
        signature: settlement.signature,
        settlementPath: settlement.settlementPath,
        signedGroundTruthValue: settlement.groundTruthValue,
        signedEntries: settlement.entries,
        registeredTee: tee.wallet,
        registeredImageDigest: tee.imageDigest,
        chainId: opts.chainId,
        verifyingContract: opts.sealedCompetition,
        commitments,
        refetchedGroundTruth,
    });
}

const MARK: Record<Check['status'], string> = {
    pass: 'PASS',
    fail: 'FAIL',
    skipped: 'SKIP',
};

export function printChecks(checks: readonly Check[]): boolean {
    for (const c of checks) {
        console.log(`  ${MARK[c.status]}  ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    const counts = countBy(checks);
    const ok = allPassed(checks);
    console.log('');
    console.log(
        ok
            ? `VERIFIED: ${counts.pass} checks re-derived independently` +
                  (counts.skipped > 0 ? `, ${counts.skipped} skipped (see above)` : '') +
                  '.'
            : `VERIFICATION FAILED: ${counts.fail} of ${checks.length} checks did not re-derive.`,
    );
    console.log('');
    return ok;
}

function envOr(name: string, fallback?: string): string | undefined {
    const v = (process.env[name] ?? '').trim();
    return v.length > 0 ? v : fallback;
}

const VALUE_FLAGS = ['tx', 'from-block', 'to-block'] as const;

/** Minimal argv split: `--name value` and `--name=value` become flags, the rest positional. */
function parseArgs(argv: readonly string[]): {
    positional: string[];
    flags: Record<string, string>;
} {
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] ?? '';
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const name = arg.slice(2).split('=')[0] ?? '';
        const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
        if (inline !== undefined) {
            flags[name] = inline;
        } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
            flags[name] = argv[i + 1] ?? '';
            i += 1; // consume the value so it is not read as a positional
        } else {
            flags[name] = 'true';
        }
    }
    return { positional, flags };
}

function usage(): void {
    console.error(
        'usage: quadra-verify <job|competition> <id> [--tx <settleTxHash>] ' +
            '[--from-block N] [--to-block N] [--json]',
    );
    console.error('');
    console.error(
        '  --tx  the settle transaction hash, from the explorer. Bounds the log scan to that',
    );
    console.error(
        '        block, which is the difference between a few requests and a few thousand when',
    );
    console.error(
        '        the settlement is not recent. It is only a search hint — every check still',
    );
    console.error('        re-derives the outcome independently.');
    console.error('');
    console.error(
        'Addresses are read from contracts/deployments/<chainId>.json when it is reachable.',
    );
    console.error(
        'env: CHAIN_RPC_URL CHAIN_ID TEE_REGISTRY JOB_ESCROW SEALED_COMPETITION FROM_BLOCK',
    );
    console.error('     DA_URL DA_API_KEY USER_PRIVATE_KEY');
}

/**
 * The CLI body, exported so `bin/quadra-verify.js` can call it directly.
 *
 * The shim cannot rely on the direct-invocation guard below: it IMPORTS this module, so
 * `import.meta.url` is the compiled file while `process.argv[1]` is the shim — they never match,
 * and the binary would exit silently having done nothing.
 */
export async function run(): Promise<void> {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const asJson = flags['json'] !== undefined;
    const kind = positional[0];
    const id = positional[1] as Hex | undefined;

    if ((kind !== 'job' && kind !== 'competition') || !id) {
        usage();
        process.exitCode = 1;
        return;
    }

    const chainId = Number(envOr('CHAIN_ID', '114'));
    const deployed = loadDeployment(chainId);
    const teeRegistry = envOr('TEE_REGISTRY') ?? deployed?.teeRegistry;
    if (!teeRegistry) {
        console.error(
            `verify: no TeeRegistry address. Set TEE_REGISTRY, or run where ` +
                `contracts/deployments/${chainId}.json is reachable.`,
        );
        process.exitCode = 1;
        return;
    }

    const jobEscrow = envOr('JOB_ESCROW') ?? deployed?.jobEscrow;
    const sealedCompetition = envOr('SEALED_COMPETITION') ?? deployed?.sealedCompetition;
    const userKey = envOr('USER_PRIVATE_KEY');

    const base: VerifyChainConfig = {
        rpcUrl: envOr('CHAIN_RPC_URL', 'https://coston2-api.flare.network/ext/C/rpc') as string,
        chainId,
        teeRegistry: teeRegistry as Address,
    };

    // `--tx` resolves to the block the settlement landed in, so the backwards scan starts there
    // instead of at the chain head. Without it, verifying a settlement from days ago walks every
    // window in between and a public RPC rate-limits it long before it arrives.
    const txFlag = flags['tx'];
    const toBlockFlag = flags['to-block'];
    const toBlock = toBlockFlag
        ? BigInt(toBlockFlag)
        : txFlag
          ? await blockOfTx(base, txFlag as Hex).catch(() => undefined)
          : undefined;
    if (txFlag && toBlock === undefined) {
        console.warn(`(could not resolve --tx ${txFlag}; scanning from the chain head)`);
    }

    const opts: VerifyOptions = {
        ...base,
        jobEscrow: jobEscrow as Address | undefined,
        sealedCompetition: sealedCompetition as Address | undefined,
        daBaseUrl: envOr('DA_URL', COSTON2_DA_URL),
        daApiKey: envOr('DA_API_KEY'),
        userPrivateKey: userKey as Hex | undefined,
        toBlock,
        fromBlock: BigInt(
            flags['from-block'] ?? envOr('FROM_BLOCK', String(deployed?.fromBlock ?? 0)) ?? '0',
        ),
        verbose: !asJson,
    };

    if (userKey && kind === 'job') {
        console.log(
            `(replaying as ${privateKeyToAccount(userKey as Hex).address} — your key opens the ` +
                'private result)',
        );
    }
    if (!asJson) console.log(`\nverifying ${kind} ${id}\n`);

    const checks =
        kind === 'job' ? await verifyJobById(id, opts) : await verifyCompetitionById(id, opts);

    let ok: boolean;
    if (asJson) {
        ok = allPassed(checks);
        console.log(JSON.stringify({ kind, id, ok, counts: countBy(checks), checks }, null, 2));
    } else {
        ok = printChecks(checks);
    }
    // Set exitCode rather than calling process.exit(), which can truncate piped stdout.
    process.exitCode = ok ? 0 : 1;
}

export function reportAndExit(err: unknown): void {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
}

// Run when invoked directly, which is the `tsx src/verify.ts` development path. Comparing against
// `file://${process.argv[1]}` is broken on Windows (argv[1] is a backslash path, import.meta.url
// is file:///C:/...), so use pathToFileURL. The published binary goes through `run()` instead.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    run().catch(reportAndExit);
}
