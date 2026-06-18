/**
 * One-off bootstrap for existing environments: create only the `eval_engines`
 * JsonPointer and print `POINTER_EVAL_ENGINES=0x...` for your `.env`.
 *
 * Run from data/:  npm run bootstrap-eval-engines
 *
 * Requires DATA_SECRET_KEY, WALRUS_JSON_PACKAGE_ID, DATA_NETWORK, DATA_EPOCHS.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { WalrusJsonClient, type JsonValue, type WalrusNetwork } from 'walrus-json';

import { EMPTY_EVAL_ENGINES } from '../src/dbs/evalEngines.js';

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

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

    console.log(`Creating eval_engines pointer on ${network} (epochs=${epochs})...\n`);
    const doc = wj.create(EMPTY_EVAL_ENGINES as JsonValue);
    const { blobId } = await doc.commit({ epochs });
    const pointerId = await wj.createPointer(blobId);
    console.log(`  POINTER_EVAL_ENGINES       ${pointerId}  (blob ${blobId})`);
    console.log('\nPaste into your .env:\n');
    console.log(`POINTER_EVAL_ENGINES=${pointerId}`);
}

main().catch((error) => {
    console.error('\nBootstrap eval_engines failed:', error);
    process.exit(1);
});
