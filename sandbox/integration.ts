/**
 * Narrated end-to-end check of the Quadra data layer against a live network.
 *
 * Run all steps:        npm run sandbox
 * Run only some steps:  npm run sandbox -- 3
 *                       npm run sandbox -- watch
 *                       npm run sandbox -- 1,3
 * Steps: 1=public (public databases), 2=seal (sealed job results), 3=watch.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

import { DataLayer } from '../src/index.js';
import type { DbName, JobResult, JobTemplate } from '../src/index.js';

process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const indent = (v: unknown) =>
    JSON.stringify(v, null, 2)
        .split('\n')
        .map((l) => '        ' + l)
        .join('\n');

function section(title: string, subtitle: string): void {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  ${title}`);
    console.log(`  ${subtitle}`);
    console.log('═'.repeat(72));
}
function step(label: string, what: string): void {
    console.log(`\n▶ ${label}`);
    console.log(`    what: ${what}`);
}
const act = (t: string) => console.log(`    → ${t}`);
const got = (label: string, v: unknown) => console.log(`    ← ${label}:\n${indent(v)}`);
const note = (t: string) => console.log(`    · ${t}`);

let passed = 0;
function check(label: string, cond: boolean): void {
    if (!cond) throw new Error(`CHECK FAILED: ${label}`);
    console.log(`    ✓ expect ${label}`);
    passed++;
}

// Every write commits a brand-new immutable blob and re-points the on-chain
// pointer at it. Read the pointer back so each write shows its new blob id.
async function blob(dl: DataLayer, db: DbName): Promise<void> {
    const p = await dl.clients.wj.readPointer(dl.config.pointers[db]);
    console.log(`    ⛁ ${db}: pointer version ${p.version} -> blob ${p.blobId}`);
}

interface Ctx {
    stamp: number;
    jobId: string;
    agentWallet: string;
    ownerWallet: string;
    template: JobTemplate;
}

async function recordAccess(
    dl: DataLayer,
    jobId: string,
    user: string,
    agent: string,
): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
        target: `${dl.config.quadraPackageId}::job_access::record`,
        arguments: [
            tx.object(dl.config.jobAccessRegistryId),
            tx.pure.string(jobId),
            tx.pure.address(user),
            tx.pure.address(agent),
        ],
    });
    const res = await dl.clients.sui.core.signAndExecuteTransaction({
        transaction: tx,
        signer: dl.clients.signer,
    });
    if (res.$kind === 'FailedTransaction') {
        throw new Error(`record access failed: ${JSON.stringify(res.FailedTransaction.status)}`);
    }
    await dl.clients.sui.core.waitForTransaction({ digest: res.Transaction.digest });
    return res.Transaction.digest;
}

async function step1Public(dl: DataLayer, c: Ctx): Promise<void> {
    section('1) PUBLIC DATABASES', 'JSON docs on Walrus, each behind an on-chain JsonPointer');

    step(
        'agent registry (on-chain)',
        'agents register on chain (agent::register_agent); read via dl.agents',
    );
    const agentAddr = dl.clients.signer.toSuiAddress();
    if (!(await dl.agents.isRegistered(agentAddr))) {
        act(`register_agent(sender=${agentAddr}, category="finance") on chain`);
        const tx = new Transaction();
        tx.moveCall({
            target: `${dl.config.quadraPackageId}::agent::register_agent`,
            arguments: [
                tx.object(dl.config.agentRegistryId),
                tx.pure.address(c.ownerWallet),
                tx.pure.string('sandbox'),
                tx.pure.string('demo agent'),
                tx.pure.string('finance'),
            ],
        });
        const res = await dl.clients.sui.core.signAndExecuteTransaction({
            transaction: tx,
            signer: dl.clients.signer,
        });
        if (res.$kind === 'FailedTransaction') {
            throw new Error(
                `register_agent failed: ${JSON.stringify(res.FailedTransaction.status)}`,
            );
        }
        await dl.clients.sui.core.waitForTransaction({ digest: res.Transaction.digest });
    } else {
        note(`${agentAddr} already registered`);
    }
    const readAgent = await dl.agents.get(agentAddr);
    got('read back dl.agents.get(addr) (on-chain)', readAgent);
    check('agent category is finance', readAgent?.category === 'finance');

    step(
        'agentScores.recordJob',
        'scores are an equal-weight running average of every delivered job',
    );
    act('recordJob(agent, 80)  — first job, so score becomes the job score');
    const s1 = await dl.agentScores.recordJob(c.agentWallet, 80);
    got('score', s1);
    check('first score = 80, total = 1', s1.score === 80 && s1.total_jobs_delivered === 1);
    act('recordJob(agent, 100) — new avg = (80*1 + 100) / 2 = 90');
    const s2 = await dl.agentScores.recordJob(c.agentWallet, 100);
    got('score', s2);
    await blob(dl, 'agent_scores');
    check('avg score = 90, total = 2', s2.score === 90 && s2.total_jobs_delivered === 2);

    step('jobTemplates.put / get', 'a well-defined job shape agents fetch by id');
    act(`put template "${c.template.id}"`);
    got('template', c.template);
    await dl.jobTemplates.put(c.template);
    await blob(dl, 'job_templates');
    const readTemplate = await dl.jobTemplates.get(c.template.id);
    got('read back jobTemplates.get("btc_price_5m")', readTemplate);
    check('template round-trips by exact id', readTemplate?.id === c.template.id);

    step('evalEngines.put / get', 'evaluator_id -> enclave HTTP URL for scheduler routing');
    const evalId = c.template.evaluator_id;
    act(`put eval engine "${evalId}"`);
    await dl.evalEngines.put({
        evaluator_id: evalId,
        url: 'http://localhost:5200',
    });
    await blob(dl, 'eval_engines');
    const readEngine = await dl.evalEngines.get(evalId);
    got('read back evalEngines.get(evaluator_id)', readEngine);
    check('eval engine round-trips by evaluator_id', readEngine?.url === 'http://localhost:5200');

    step(
        'jobScheduler.set / due / remove',
        'job_id -> expiry; the scheduler engine reads due jobs each epoch',
    );
    const expiry = c.stamp - 1000; // already in the past, so it is "due"
    act(`set("${c.jobId}", ${expiry})  (expiry in the past -> immediately due)`);
    await dl.jobScheduler.set(c.jobId, expiry);
    await blob(dl, 'job_scheduler');
    const due = await dl.jobScheduler.due(c.stamp);
    got('due(now) returns', due);
    check(
        'our job is reported due',
        due.some((j) => j.job_id === c.jobId),
    );
    act(`remove("${c.jobId}")  (engine handled it)`);
    await dl.jobScheduler.remove(c.jobId);
    const stillThere = (await dl.jobScheduler.list()).some((j) => j.job_id === c.jobId);
    check('job is gone after remove', !stillThere);

    step('delayedFailedJobs.add / list', 'append-only log written when evaluation errors');
    act(`add { job_id: ${c.jobId}, kind: "failed", reason: "eval timeout" }`);
    const failed = await dl.delayedFailedJobs.add({
        job_id: c.jobId,
        kind: 'failed',
        reason: 'eval timeout',
    });
    got('appended entry', failed);
    await blob(dl, 'delayed_failed_jobs');
    check(
        'failure is logged',
        (await dl.delayedFailedJobs.list()).some((j) => j.job_id === c.jobId),
    );
}

async function step2Seal(dl: DataLayer, c: Ctx): Promise<void> {
    section('2) SEALED JOB RESULTS', 'Seal-encrypted; only the job user + agent can decrypt');

    const user = dl.clients.signer; // the data-layer signer plays the paying user here
    const userAddr = user.toSuiAddress();
    const stranger = Ed25519Keypair.generate();
    note(`user (allowed)    ${userAddr}`);
    note(`agent (allowed)   ${c.agentWallet}`);
    note(`stranger (denied) ${stranger.toSuiAddress()}`);

    step(
        'job_access::record',
        'put {job_id -> (user, agent)} on chain so seal_approve can authorize them',
    );
    note('(normally done inside intake::pay_for_job when the user pays; here we call it directly)');
    act(`record(${c.jobId}, user, agent) on ${dl.config.quadraPackageId}::job_access`);
    const digest = await recordAccess(dl, c.jobId, userAddr, c.agentWallet);
    note(`tx ${digest} confirmed`);

    step(
        'jobResults.store',
        'encrypt the whole result under identity=job_id, write the blob, index it',
    );
    const result: JobResult = {
        job_id: c.jobId,
        user: userAddr,
        agent: c.agentWallet,
        status: 'delivered',
        job: { lifetime: '5m', template: c.template },
        agent_result: { minPrice: 64000, maxPrice: 65000 },
        finalized_result: { minPrice: 64200, maxPrice: 64800 },
        score: 90,
        started_at: c.stamp,
        delivered_at: c.stamp + 300_000,
    };
    got('plaintext result (this is what gets encrypted)', result);
    const { blobId } = await dl.jobResults.store(result);
    note(`encrypted result stored as Walrus blob ${blobId}`);
    await blob(dl, 'job_results_index');
    const indexed = await dl.jobResultsIndex.get(c.jobId);
    note(`results index entry: ${c.jobId} -> ${indexed}`);
    check('results index maps job -> blob', indexed === blobId);

    step(
        'jobResults.fetchSealed',
        'anyone can fetch the ciphertext envelope — but it is unreadable',
    );
    const sealed = await dl.jobResults.fetchSealed(c.jobId);
    note(
        `envelope: { sealed: ${sealed.sealed}, job_id: ${sealed.job_id}, enc: <${sealed.enc.length} base64 chars> }`,
    );
    note(`enc preview: ${sealed.enc.slice(0, 48)}…`);
    check('envelope is marked sealed', sealed.sealed === true);

    step(
        'jobResults.decrypt(user)',
        'user builds a SessionKey, key servers dry-run seal_approve, then decrypt',
    );
    const decrypted = await dl.jobResults.decrypt(c.jobId, user);
    got('decrypted result', decrypted);
    check('user reads score back = 90', decrypted.score === 90 && decrypted.job_id === c.jobId);

    step(
        'jobResults.decrypt(stranger)',
        'a third party is NOT user or agent -> seal_approve must reject',
    );
    // Fresh DataLayer so the Seal key cache is empty; otherwise the stranger would
    // reuse the key the user just cached and skip the on-chain policy check.
    note('using a fresh client (empty key cache) so seal_approve is actually evaluated');
    const strangerDl = DataLayer.fromEnv();
    let denyMsg = '';
    try {
        await strangerDl.jobResults.decrypt(c.jobId, stranger);
    } catch (e) {
        denyMsg = e instanceof Error ? e.message : String(e);
    }
    note(`stranger got error: ${denyMsg || '(none!)'}`);
    check('stranger is denied by seal_approve', denyMsg.length > 0);
}

async function step3Watch(dl: DataLayer, c: Ctx): Promise<void> {
    section('3) WATCH', 'gRPC watcher in a SEPARATE process catches an on-chain write');
    note('the gRPC stream only survives in a write-free process, so the watcher runs as a child;');
    note('we do the write here, fully, THEN start the watcher replaying from the pre-write');
    note('checkpoint (it backfills via getCheckpoint) — mirroring the serve/watch split.');

    const rpc = new SuiJsonRpcClient({
        network: dl.config.network,
        url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(dl.config.network),
    });

    step('jobScheduler.set', 'write from THIS process; bumps the pointer + emits PointerUpdated');
    const before = await dl.clients.wj.readPointer(dl.config.pointers.job_scheduler);
    note(`scheduler pointer version BEFORE write: ${before.version}`);
    await dl.jobScheduler.set(`watch-${c.stamp}`, c.stamp);
    const after = await dl.clients.wj.readPointer(dl.config.pointers.job_scheduler);
    note(`scheduler pointer version AFTER write:  ${after.version} (blob ${after.blobId})`);

    // The PointerUpdated lands at the very end of the write, so replay from just
    // before the current head: a tiny, reliable backfill window.
    const head = Number(await rpc.getLatestCheckpointSequenceNumber());
    const fromCheckpoint = Math.max(0, head - 20);

    step(
        'spawn watch process',
        `gRPC watcher in its own process, replaying from checkpoint ${fromCheckpoint}`,
    );
    const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const childPath = fileURLToPath(new URL('./watch-child.ts', import.meta.url));
    const dataDir = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(tsxBin, [childPath], {
        cwd: dataDir,
        env: { ...process.env, WATCH_FROM: String(fromCheckpoint) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
        out += d;
        for (const line of String(d).trim().split('\n')) if (line) note(`[watch child] ${line}`);
    });
    child.stderr.on('data', (d) => {
        for (const line of String(d).trim().split('\n'))
            if (line) note(`[watch child:err] ${line}`);
    });

    act('waiting for the watcher to backfill + report the change…');
    const code = await new Promise<number>((resolve) => child.on('exit', (cd) => resolve(cd ?? 1)));
    check(
        'separate-process gRPC watcher caught the job_scheduler change',
        out.includes('WATCH_OK') && code === 0,
    );
}

const ALIAS: Record<string, string> = { public: '1', seal: '2', watch: '3' };

function selectedSteps(): Set<string> {
    const tokens = process.argv
        .slice(2)
        .flatMap((a) => a.split(','))
        .map((s) =>
            s
                .trim()
                .replace(/^-+/, '')
                .replace(/^(only|step)=/, '')
                .toLowerCase(),
        )
        .filter(Boolean)
        .map((t) => ALIAS[t] ?? t);
    return tokens.length ? new Set(tokens) : new Set(['1', '2', '3']);
}

async function main(): Promise<void> {
    const steps = selectedSteps();
    const dl = DataLayer.fromEnv();
    const stamp = Date.now();
    const ctx: Ctx = {
        stamp,
        jobId: `job-${stamp}`,
        // Fresh addresses each run so persisted state (scores, identity) starts clean.
        agentWallet: Ed25519Keypair.generate().toSuiAddress(),
        ownerWallet: Ed25519Keypair.generate().toSuiAddress(),
        template: {
            id: 'price_range_5m',
            category: 'finance',
            description: 'Predict the price range over the lifetime window',
            output: { minPrice: 'number', maxPrice: 'number' },
            evaluator_id: 'price-range-guess',
            start_data_template: { start_price: 'number' },
            minimum_lifetime: 60_000,
            allowed_assets: ['BTC', 'ETH', 'SOL', 'SUI'],
        },
    };

    section('SETUP', 'who we are and what we are writing to');
    note(`network            ${dl.config.network}`);
    note(`signer (data layer) ${dl.clients.signer.toSuiAddress()}`);
    note(`walrus_json package ${dl.config.walrusJsonPackageId}`);
    note(`quadra package      ${dl.config.quadraPackageId}`);
    note(`job_access registry ${dl.config.jobAccessRegistryId}`);
    note(`run job id          ${ctx.jobId}`);
    note(`steps              ${[...steps].sort().join(', ')}`);
    console.log('    pointers (one per DB, each a stable on-chain handle to the latest blob):');
    for (const [db, id] of Object.entries(dl.config.pointers)) {
        console.log(`      ${db.padEnd(20)} ${id}`);
    }

    if (steps.has('1')) await step1Public(dl, ctx);
    if (steps.has('2')) await step2Seal(dl, ctx);
    if (steps.has('3')) await step3Watch(dl, ctx);

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  ALL ${passed} CHECKS PASSED`);
    console.log('═'.repeat(72));
}

main().catch((error) => {
    console.error('\n✗ Integration failed:', error);
    process.exit(1);
});
