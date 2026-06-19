/**
 * One-shot environment setup. Reads your DATA_SECRET_KEY (+ DATA_NETWORK) from
 * data/.env, then derives and writes EVERY other value back into data/.env:
 *
 *   - publishes the `walrus_json` Move package      -> WALRUS_JSON_PACKAGE_ID
 *   - publishes the `quadra` Move package           -> QUADRA_PACKAGE_ID
 *                                                      + JOB_ACCESS_REGISTRY_ID
 *   - creates the seven JsonPointers                   -> POINTER_*
 *   - fills sensible defaults                        -> DATA_EPOCHS, SEAL_THRESHOLD, PORT
 *
 * Everything is signed with YOUR key (no separate sui CLI account). The only
 * value it cannot derive is SEAL_KEY_SERVER_IDS — those are external Seal
 * infrastructure; paste them from the Seal verified-key-servers list. Public DBs
 * and watch work without it; only sealed job-result decryption needs it.
 *
 * Requires the `sui` CLI on PATH (used only to compile the Move bytecode), and a
 * DATA_SECRET_KEY address funded with SUI (gas, for publishing) and WAL (storage,
 * for the pointers).
 *
 * Run from data/:  npm run setup
 * Re-running publishes fresh packages and pointers (old ones simply go unused).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { WalrusJsonClient, type JsonValue, type WalrusNetwork } from 'walrus-json';

import { EMPTY_AGENT_SCORES } from '../src/dbs/agentScores.js';
import { EMPTY_AGENT_ENDPOINTS } from '../src/dbs/agentEndpoints.js';
import { EMPTY_DELAYED_FAILED } from '../src/dbs/delayedFailedJobs.js';
import { EMPTY_JOB_TEMPLATES } from '../src/dbs/jobTemplates.js';
import { EMPTY_JOB_SCHEDULER } from '../src/dbs/jobScheduler.js';
import { EMPTY_JOB_RESULTS_INDEX } from '../src/dbs/jobResultsIndex.js';
import { EMPTY_EVAL_ENGINES } from '../src/dbs/evalEngines.js';

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

const DATA_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENV_PATH = path.join(DATA_DIR, '.env');
const WALRUS_JSON_MOVE = path.resolve(DATA_DIR, '../walrus-json/move/walrus_json');
const QUADRA_MOVE = path.resolve(DATA_DIR, '../contracts');

/**
 * Mysten's allowlisted open-mode Seal key servers. Used as a default when
 * SEAL_KEY_SERVER_IDS isn't already set. (Mainnet ids are not bundled — supply
 * them yourself from the Seal verified key servers list.)
 */
const DEFAULT_SEAL_KEY_SERVERS: Partial<Record<WalrusNetwork, string[]>> = {
    testnet: [
        '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
        '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
    ],
};

const POINTER_DBS: { envVar: string; initial: unknown }[] = [
    { envVar: 'POINTER_AGENT_SCORES', initial: EMPTY_AGENT_SCORES },
    { envVar: 'POINTER_AGENT_ENDPOINTS', initial: EMPTY_AGENT_ENDPOINTS },
    { envVar: 'POINTER_DELAYED_FAILED', initial: EMPTY_DELAYED_FAILED },
    { envVar: 'POINTER_JOB_TEMPLATES', initial: EMPTY_JOB_TEMPLATES },
    { envVar: 'POINTER_JOB_SCHEDULER', initial: EMPTY_JOB_SCHEDULER },
    { envVar: 'POINTER_JOB_RESULTS_INDEX', initial: EMPTY_JOB_RESULTS_INDEX },
    { envVar: 'POINTER_EVAL_ENGINES', initial: EMPTY_EVAL_ENGINES },
];

/** Parse a `.env` file into an ordered key/value map (ignores comments/blanks). */
function parseEnv(text: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
    return map;
}

/** Compile a Move package and publish it with the data signer. */
async function publishPackage(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    sender: string,
    dir: string,
    label: string,
): Promise<{ packageId: string; objectTypes: Record<string, string> }> {
    console.log(`\nPublishing ${label} (${dir})...`);
    const raw = execFileSync('sui', ['move', 'build', '--dump-bytecode-as-base64', '--path', dir], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    // The CLI may print progress before the JSON; take from the first '{'.
    const json = JSON.parse(raw.slice(raw.indexOf('{'))) as {
        modules: string[];
        dependencies: string[];
    };

    const tx = new Transaction();
    const cap = tx.publish({ modules: json.modules, dependencies: json.dependencies });
    tx.transferObjects([cap], sender);

    const result = await client.core.signAndExecuteTransaction({
        transaction: tx,
        signer,
        include: { effects: true, objectTypes: true },
    });
    if (result.$kind === 'FailedTransaction') {
        throw new Error(
            `Publish ${label} failed: ${JSON.stringify(result.FailedTransaction.status)}`,
        );
    }
    const txn = result.Transaction;
    await client.core.waitForTransaction({ digest: txn.digest });

    const pkg = txn.effects?.changedObjects.find((o) => o.outputState === 'PackageWrite');
    if (!pkg) throw new Error(`Publish ${label} succeeded but no package object was found`);
    console.log(`  ${label} packageId: ${pkg.objectId}`);
    return { packageId: pkg.objectId, objectTypes: txn.objectTypes ?? {} };
}

async function main(): Promise<void> {
    if (!existsSync(ENV_PATH)) {
        throw new Error(
            `No .env at ${ENV_PATH}. Copy .env.example to .env and set DATA_SECRET_KEY first.`,
        );
    }
    const env = parseEnv(readFileSync(ENV_PATH, 'utf8'));

    const secret = env.get('DATA_SECRET_KEY');
    if (!secret) throw new Error('DATA_SECRET_KEY is not set in .env');
    const network = (env.get('DATA_NETWORK') ?? 'testnet') as WalrusNetwork;
    const epochs = Number(env.get('DATA_EPOCHS') ?? '5');

    const signer = Ed25519Keypair.fromSecretKey(secret);
    const sender = signer.toSuiAddress();
    const url = env.get('DATA_BASE_URL') ?? getJsonRpcFullnodeUrl(network);
    const client = new SuiJsonRpcClient({ network, url });

    console.log(`Setup on ${network}`);
    console.log(`  signer address: ${sender}`);
    console.log(`  (needs SUI for publishing + WAL for the ${POINTER_DBS.length} pointers)`);

    // 1. Publish both Move packages with the data key.
    const walrusJson = await publishPackage(
        client,
        signer,
        sender,
        WALRUS_JSON_MOVE,
        'walrus_json',
    );
    const quadra = await publishPackage(client, signer, sender, QUADRA_MOVE, 'quadra');

    const findShared = (suffix: string): string => {
        const entry = Object.entries(quadra.objectTypes).find(([, type]) => type.endsWith(suffix));
        if (!entry) throw new Error(`quadra published but no ${suffix} shared object was found`);
        return entry[0];
    };
    const jobAccessRegistryId = findShared('::job_access::JobAccessRegistry');
    const agentRegistryId = findShared('::agent::AgentRegistry');
    console.log(`  JobAccessRegistry: ${jobAccessRegistryId}`);
    console.log(`  AgentRegistry:     ${agentRegistryId}`);

    // 2. Create the seven pointers with the freshly published walrus_json package.
    console.log(`\nCreating ${POINTER_DBS.length} pointers...`);
    const wj = new WalrusJsonClient({
        network,
        signer,
        packageId: walrusJson.packageId,
        defaultEpochs: epochs,
        ...(env.get('DATA_BASE_URL') ? { baseUrl: env.get('DATA_BASE_URL') } : {}),
    });
    const pointers: Record<string, string> = {};
    for (const { envVar, initial } of POINTER_DBS) {
        const doc = wj.create(initial as JsonValue);
        const { blobId } = await doc.commit({ epochs });
        const pointerId = await wj.createPointer(blobId);
        pointers[envVar] = pointerId;
        console.log(`  ${envVar.padEnd(26)} ${pointerId}`);
    }

    // 3. Compose the new .env, preserving the secret and anything already set.
    // Default Seal key servers for the network when the user hasn't set them.
    const sealServers =
        env.get('SEAL_KEY_SERVER_IDS') || (DEFAULT_SEAL_KEY_SERVERS[network] ?? []).join(',');
    const lines = [
        '# --- Quadra data layer configuration (generated by `npm run setup`) ---',
        '',
        `DATA_SECRET_KEY=${secret}`,
        `DATA_NETWORK=${network}`,
        ...(env.get('DATA_BASE_URL') ? [`DATA_BASE_URL=${env.get('DATA_BASE_URL')}`] : []),
        `DATA_EPOCHS=${epochs}`,
        '',
        `WALRUS_JSON_PACKAGE_ID=${walrusJson.packageId}`,
        `QUADRA_PACKAGE_ID=${quadra.packageId}`,
        `JOB_ACCESS_REGISTRY_ID=${jobAccessRegistryId}`,
        `AGENT_REGISTRY_ID=${agentRegistryId}`,
        '',
        '# External Seal infrastructure — paste from the Seal verified key servers list.',
        `SEAL_KEY_SERVER_IDS=${sealServers}`,
        `SEAL_THRESHOLD=${env.get('SEAL_THRESHOLD') ?? '1'}`,
        '',
        ...(env.get('DATA_GRPC_URL') ? [`DATA_GRPC_URL=${env.get('DATA_GRPC_URL')}`] : []),
        `PORT=${env.get('PORT') ?? '8787'}`,
        '',
        ...POINTER_DBS.map(({ envVar }) => `${envVar}=${pointers[envVar]}`),
        '',
    ];

    copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
    writeFileSync(ENV_PATH, lines.join('\n'));
    console.log(`\nWrote ${ENV_PATH} (previous saved to .env.bak).`);

    if (!sealServers) {
        console.log(
            '\n⚠  SEAL_KEY_SERVER_IDS is still empty. Public DBs + watch work now;\n' +
                '   set it (comma-separated key server object ids) to enable sealed job results.',
        );
    }
    console.log('\nDone. Next: npm run sandbox  (or npm run serve).');
}

main().catch((error) => {
    console.error('\nSetup failed:', error);
    process.exit(1);
});
