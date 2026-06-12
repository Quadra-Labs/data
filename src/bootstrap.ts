/**
 * One-time setup: create the six public `JsonPointer` objects, each seeded with
 * an empty document. Run once per environment, then paste the printed ids into
 * your `.env`.
 *
 *   POINTER_AGENT_SCORES=0x...
 *   POINTER_AGENTS=0x...
 *   ...
 *
 * Requires DATA_SECRET_KEY, WALRUS_JSON_PACKAGE_ID, DATA_NETWORK, DATA_EPOCHS.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { WalrusJsonClient, type JsonValue, type WalrusNetwork } from 'walrus-json';

import { EMPTY_AGENT_SCORES } from './dbs/agentScores.js';
import { EMPTY_DELAYED_FAILED } from './dbs/delayedFailedJobs.js';
import { EMPTY_JOB_TEMPLATES } from './dbs/jobTemplates.js';
import { EMPTY_JOB_SCHEDULER } from './dbs/jobScheduler.js';
import { EMPTY_JOB_RESULTS_INDEX } from './dbs/jobResultsIndex.js';

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

const DATABASES: { envVar: string; initial: unknown }[] = [
    { envVar: 'POINTER_AGENT_SCORES', initial: EMPTY_AGENT_SCORES },
    { envVar: 'POINTER_DELAYED_FAILED', initial: EMPTY_DELAYED_FAILED },
    { envVar: 'POINTER_JOB_TEMPLATES', initial: EMPTY_JOB_TEMPLATES },
    { envVar: 'POINTER_JOB_SCHEDULER', initial: EMPTY_JOB_SCHEDULER },
    { envVar: 'POINTER_JOB_RESULTS_INDEX', initial: EMPTY_JOB_RESULTS_INDEX },
];

async function main(): Promise<void> {
    try {
        process.loadEnvFile('.env');
    } catch {
        // No .env file — rely on the ambient environment.
    }

    const network = (process.env.DATA_NETWORK ?? 'testnet') as WalrusNetwork;
    const epochs = Number(process.env.DATA_EPOCHS ?? '5');
    const wj = new WalrusJsonClient({
        network,
        signer: Ed25519Keypair.fromSecretKey(required('DATA_SECRET_KEY')),
        packageId: required('WALRUS_JSON_PACKAGE_ID'),
        defaultEpochs: epochs,
        ...(process.env.DATA_BASE_URL ? { baseUrl: process.env.DATA_BASE_URL } : {}),
    });

    console.log(`Bootstrapping ${DATABASES.length} pointers on ${network} (epochs=${epochs})...\n`);
    const lines: string[] = [];
    for (const { envVar, initial } of DATABASES) {
        const doc = wj.create(initial as JsonValue);
        const { blobId } = await doc.commit({ epochs });
        const pointerId = await wj.createPointer(blobId);
        console.log(`  ${envVar.padEnd(26)} ${pointerId}  (blob ${blobId})`);
        lines.push(`${envVar}=${pointerId}`);
    }

    console.log('\nPaste these into your .env:\n');
    console.log(lines.join('\n'));
}

main().catch((error) => {
    console.error('\nBootstrap failed:', error);
    process.exit(1);
});
