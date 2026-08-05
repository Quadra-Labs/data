/**
 * integration.ts — the narrated end-to-end run.
 *
 * Keeps the Sui sandbox's shape, which was the best demo artifact either project had: numbered
 * sections, an `act`/`got` pair for every step so the output reads as an argument rather than a
 * log, and a running count of checks that actually passed.
 *
 * Run all of it, or pick steps:
 *
 *     pnpm sandbox                 every step
 *     pnpm sandbox -- 2,5          by number
 *     pnpm sandbox -- envelope     by name
 *
 * Steps 2 to 5 need no chain and no keys — they run offline. Step 1 reads live Coston2.
 */

import '../src/boot.js';

import { keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
    sealEnvelope,
    openEnvelope,
    openEnvelopeWithTeeKey,
    receiptBytes,
    receiptHash,
    scorePriceRange,
    competitionDomain,
    competitionTypes,
    FEED_IDS,
    normalizeToPrice,
    type Receipt,
} from 'quadra-core';
import { fetchGroundTruth, votingRoundIdForTimestamp } from 'quadra-core/ground-truth';
import { verifyCompetition, countBy, type Check } from 'quadra-core/verify';

import { loadConfig } from '../src/config.js';
import { makeClient } from '../src/chain/client.js';
import { makeTeeRegistryReader, makePassportReader, categoryOf } from '../src/chain/index.js';
import { makeEventBus } from '../src/server/events.js';
import { startMockDa } from './mockDa.js';

// --- narration ------------------------------------------------------------------------------------

let passed = 0;
let failed = 0;

const section = (n: number, title: string): void =>
    console.log(`\n${'='.repeat(74)}\n  ${n}. ${title}\n${'='.repeat(74)}`);
const step = (s: string): void => console.log(`\n${s}`);
const act = (s: string): void => console.log(`  → ${s}`);
const got = (s: string): void => console.log(`    ${s}`);
const note = (s: string): void => console.log(`  · ${s}`);

function check(label: string, ok: boolean, detail = ''): void {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// --- 1. the read layer ----------------------------------------------------------------------------

async function stepIndex(): Promise<void> {
    section(1, 'The read layer, against live Coston2');
    const loaded = loadConfig();
    if (!loaded.ok) {
        note(`skipped: missing ${loaded.missing.join(', ')}`);
        return;
    }
    const cfg = loaded.config;
    const client = makeClient(cfg);

    act(`reading the chain head on chain ${cfg.chainId}`);
    const head = await client.getBlockNumber();
    got(`block ${head}`);
    check('the configured RPC answers', head > 0n);

    act('reading the TEE registry — who is allowed to settle');
    const tee = await makeTeeRegistryReader(client, cfg.teeRegistry, 30_000).identity();
    got(`registered=${tee.registered} wallet=${tee.wallet}`);
    got(`imageDigest="${tee.imageDigest}"`);
    if (!tee.registered) {
        note('nothing can settle yet — every settlement path requires this wallet to sign.');
        note('That is expected until the evaluation engine boots (DEPLOYMENT-STATE.md, Gap 1).');
    }
    check('the registry is readable', typeof tee.wallet === 'string');

    act('reading the Passport — reputation, straight from the contract');
    const passport = makePassportReader(client, cfg.passport);
    const evaluatorId = 'price-range-guess';
    got(`category("${evaluatorId}") = ${categoryOf(evaluatorId)}`);
    got(`agents scored so far: ${await passport.count(evaluatorId)}`);
    const fresh = await passport.track(
        '0x000000000000000000000000000000000000dEaD' as Address,
        evaluatorId,
    );
    got(`an unscored agent reads overall=${fresh.overall}, rank=${fresh.rank}`);
    // 50, not 0: a fresh agent sits at the contract's Bayesian prior, so it does not rank below
    // an agent with a genuinely bad record.
    check('an unproven agent sits at the prior, not at zero', fresh.overall === 50);
}

// --- 2. the envelope ------------------------------------------------------------------------------

async function stepEnvelope(): Promise<void> {
    section(2, 'Dual-reader encryption — exactly two parties can read a paid result');
    // Keep the raw keys: viem accounts expose a public key but never the private one.
    const keypair = () => {
        const privateKey = generatePrivateKey();
        return { privateKey, ...privateKeyToAccount(privateKey) };
    };
    const buyer = keypair();
    const tee = keypair();
    const operator = keypair();
    const forecast = { minPrice: '5900000000000', maxPrice: '6100000000000' };

    act('the agent seals its forecast to the buyer AND the TEE');
    const sealed = await sealEnvelope(buyer.publicKey, tee.publicKey, forecast);
    got(`ciphertext ${sealed.ciphertext.length} chars, commitment ${sealed.ciphertextHash}`);
    note('this ciphertext is the calldata of deliver(); the chain stores only its hash.');

    act('the buyer opens it with their own key');
    check(
        'the buyer reads the forecast',
        JSON.stringify(openEnvelope(buyer.privateKey, sealed.ciphertext)) ===
            JSON.stringify(forecast),
    );

    act('the TEE opens it with its own key, to score it');
    check(
        'the TEE reads the forecast',
        JSON.stringify(await openEnvelopeWithTeeKey(tee.privateKey, sealed.ciphertext)) ===
            JSON.stringify(forecast),
    );

    act('the marketplace operator tries to read it');
    let operatorRead = false;
    try {
        openEnvelope(operator.privateKey, sealed.ciphertext);
        operatorRead = true;
    } catch {
        /* expected */
    }
    check('the operator cannot', !operatorRead);
    note('On Sui this was enforced by a contract and a threshold of key servers.');
    note('Here it is arithmetic: only two wraps exist, so there is nothing to trust.');

    act('the commitment binds the exact bytes');
    check('keccak(ciphertext) matches what deliver() would store',
        sealed.ciphertextHash === keccak256(sealed.ciphertext));
}

// --- 3. ground truth ------------------------------------------------------------------------------

async function stepOracle(): Promise<void> {
    section(3, 'Ground truth — the real code path, offline');
    const da = await startMockDa();
    try {
        got(`mock DA layer on ${da.baseUrl}`);
        note('It answers the documented anchor-feeds shape: round as a QUERY param, turnoutBIPS.');
        note('Both are traps that pass in a lenient mock and fail on Coston2.');

        const round = votingRoundIdForTimestamp(Math.floor(Date.now() / 1000));
        act(`fetching BTC/USD at voting round ${round}`);
        const g = await fetchGroundTruth({
            daBaseUrl: da.baseUrl,
            feedId: FEED_IDS['BTC/USD'],
            votingRoundId: round,
        });
        got(`raw value=${g.feed.body.value} decimals=${g.feed.body.decimals}`);
        got(`normalized to 1e-8: ${g.value}  ($${(Number(g.value) / 1e8).toFixed(2)})`);
        check('the round we asked for is the round we got', g.feed.body.votingRoundId === round);
        check('normalization matches FtsoLib', g.value === normalizeToPrice(6_050_050, 2));

        act('asking for the same round again');
        const again = await fetchGroundTruth({
            daBaseUrl: da.baseUrl,
            feedId: FEED_IDS['BTC/USD'],
            votingRoundId: round,
        });
        // A finalized round never changes its answer. That is what makes a settlement replayable
        // later by someone who was not there.
        check('a finalized round is stable', again.value === g.value);
    } finally {
        await da.stop();
    }
}

// --- 4. the push feed -----------------------------------------------------------------------------

async function stepWatch(): Promise<void> {
    section(4, 'The push feed — one subscriber, no polling');
    const bus = makeEventBus();
    const seen: string[] = [];

    act('subscribing');
    const unsubscribe = bus.subscribe((e) => seen.push(e.kind));
    got(`${bus.size} subscriber`);

    act('the indexer applies a batch');
    bus.publish({ kind: 'JobPaid', blockNumber: 1, txHash: '0xaa', atMs: Date.now() });
    bus.publish({ kind: 'Delivered', blockNumber: 2, txHash: '0xbb', atMs: Date.now() });
    got(`subscriber received: ${seen.join(', ')}`);
    check('events reach the subscriber in order', seen.join(',') === 'JobPaid,Delivered');

    act('a subscriber that throws');
    bus.subscribe(() => {
        throw new Error('broken client');
    });
    let survived = true;
    try {
        bus.publish({ kind: 'JobScored', blockNumber: 3, txHash: '0xcc', atMs: Date.now() });
    } catch {
        survived = false;
    }
    // One broken client must never propagate back into the indexer's write path.
    check('one broken subscriber does not break the feed', survived && seen.length === 3);

    unsubscribe();
    bus.publish({ kind: 'Settled', blockNumber: 4, txHash: '0xdd', atMs: Date.now() });
    check('unsubscribing stops delivery', seen.length === 3);
}

// --- 5. the replay --------------------------------------------------------------------------------

async function stepVerify(): Promise<void> {
    section(5, 'Replay — re-deriving a settlement without trusting whoever produced it');
    const tee = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    const agentA = '0x1111111111111111111111111111111111111111' as Address;
    const agentB = '0x2222222222222222222222222222222222222222' as Address;
    const chainId = 114;
    const market = '0x3333333333333333333333333333333333333333' as Address;
    const image = 'sha256:example';

    const endPrice = 6_050_050_000_000n;
    const startPrice = 6_000_000_000_000n;
    const bandA = { minPrice: '5900000000000', maxPrice: '6100000000000' };
    const bandB = { minPrice: '100', maxPrice: '200' };

    act('the TEE scores two sealed submissions');
    const scoreA = scorePriceRange(
        { minPrice: BigInt(bandA.minPrice), maxPrice: BigInt(bandA.maxPrice) },
        endPrice,
        startPrice,
        3600,
    );
    const scoreB = scorePriceRange(
        { minPrice: BigInt(bandB.minPrice), maxPrice: BigInt(bandB.maxPrice) },
        endPrice,
        startPrice,
        3600,
    );
    got(`agent A (band contains the price): ${scoreA.ok ? scoreA.score : 0}`);
    got(`agent B (band far below):          ${scoreB.ok ? scoreB.score : 0}`);

    const receipt: Receipt = {
        competitionId: keccak256(toHex('sandbox-competition')),
        evaluatorId: 'price-range-guess',
        teeImageDigest: image,
        groundTruth: {
            kind: 'ftso-anchor',
            feedId: FEED_IDS['BTC/USD'],
            votingRoundId: 1_416_930,
            value: '6050050',
            decimals: 2,
        },
        startValue: String(startPrice),
        lifetimeSecs: 3600,
        entries: [
            {
                agent: agentA,
                ciphertextHash: keccak256(toHex('ct-a')),
                revealed: bandA,
                score: scoreA.ok ? scoreA.score : 0,
            },
            {
                agent: agentB,
                ciphertextHash: keccak256(toHex('ct-b')),
                revealed: bandB,
                score: scoreB.ok ? scoreB.score : 0,
            },
        ],
        resolvedAt: Math.floor(Date.now() / 1000),
    };

    act('the TEE publishes a receipt and signs the settlement');
    const anchored = receiptHash(receipt);
    got(`receipt ${receiptBytes(receipt).length} chars, anchored as ${anchored.slice(0, 18)}...`);

    const signedEntries = receipt.entries.map((e) => ({
        agent: e.agent,
        score: BigInt(e.score),
    }));
    const sign = (signer: typeof tee) =>
        signer.signTypedData({
            domain: competitionDomain(chainId, market),
            types: competitionTypes,
            primaryType: 'Settlement',
            message: {
                competitionId: receipt.competitionId,
                receiptHash: anchored,
                groundTruthValue: endPrice,
                entries: signedEntries,
            },
        });

    const commitments = new Map<string, Hex>([
        [agentA.toLowerCase(), keccak256(toHex('ct-a'))],
        [agentB.toLowerCase(), keccak256(toHex('ct-b'))],
    ]);
    const base = {
        receiptBody: receiptBytes(receipt),
        anchoredReceiptHash: anchored,
        signedGroundTruthValue: endPrice,
        signedEntries,
        registeredTee: tee.address,
        registeredImageDigest: image,
        chainId,
        verifyingContract: market,
        commitments,
        refetchedGroundTruth: { rawValue: '6050050', normalized: endPrice },
    };

    step('  a verifier who trusts nobody re-derives the whole thing:');
    const checks = await verifyCompetition({ ...base, signature: await sign(tee) });
    for (const c of checks) {
        console.log(`  ${c.status.toUpperCase().padEnd(7)} ${c.label}`);
    }
    const counts = countBy(checks);
    check(
        'every check re-derives',
        counts.fail === 0,
        `${counts.pass} passed, ${counts.skipped} skipped`,
    );

    step('  now the same settlement, signed by somebody else:');
    const forged = await verifyCompetition({ ...base, signature: await sign(impostor) });
    const signerCheck = forged.find((c: Check) => c.label.includes('EIP-712 signer'));
    got(`${signerCheck?.status.toUpperCase()}  ${signerCheck?.label}`);
    check('a forged signature is caught', signerCheck?.status === 'fail');

    step('  and with one score quietly changed:');
    const tampered: Receipt = {
        ...receipt,
        entries: [{ ...receipt.entries[0]!, score: 42 }, receipt.entries[1]!],
    };
    const tamperedHash = receiptHash(tampered);
    const tamperedChecks = await verifyCompetition({
        ...base,
        receiptBody: receiptBytes(tampered),
        anchoredReceiptHash: tamperedHash,
        signature: await sign(tee),
        signedEntries: tampered.entries.map((e) => ({ agent: e.agent, score: BigInt(e.score) })),
    });
    const replay = tamperedChecks.find((c: Check) => c.label.includes('replayed scores'));
    got(`${replay?.status.toUpperCase()}  ${replay?.label} — ${replay?.detail ?? ''}`);
    check('a changed score does not survive a replay', replay?.status === 'fail');
}

// --- runner ---------------------------------------------------------------------------------------

const STEPS: ReadonlyArray<{ name: string; run: () => Promise<void> }> = [
    { name: 'index', run: stepIndex },
    { name: 'envelope', run: stepEnvelope },
    { name: 'oracle', run: stepOracle },
    { name: 'watch', run: stepWatch },
    { name: 'verify', run: stepVerify },
];

/** `1,3` or `envelope` or nothing at all. */
function selected(argv: readonly string[]): typeof STEPS {
    const raw = argv
        .filter((a) => !a.startsWith('-'))
        .flatMap((a) => a.split(','))
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 0);
    if (raw.length === 0) return STEPS;
    return STEPS.filter(
        (s, i) => raw.includes(s.name) || raw.includes(String(i + 1)),
    );
}

async function main(): Promise<void> {
    const chosen = selected(process.argv.slice(2));
    console.log('\nquadra-data sandbox');
    console.log(`running: ${chosen.map((s) => s.name).join(', ')}`);

    for (const s of chosen) {
        await s.run();
    }

    console.log(`\n${'='.repeat(74)}`);
    console.log(`  ${passed} checks passed, ${failed} failed`);
    console.log(`${'='.repeat(74)}\n`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
});
