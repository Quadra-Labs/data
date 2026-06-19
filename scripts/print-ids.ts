/**
 * Print the on-chain object ids the quadra publish minted that older `setup` runs didn't
 * capture: INTAKE_CAP_ID, INTAKE_CONFIG_ID, COMPETITION_CAP_ID. Reads QUADRA_PACKAGE_ID +
 * DATA_NETWORK from data/.env, finds the publish transaction via the package object's
 * previousTransaction, and prints ready-to-paste env lines. Read-only; signs nothing.
 *
 * Run from data/:  npm run print-ids
 */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { WalrusNetwork } from 'walrus-json';

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
}

// type suffix -> the env var the engines expect.
const WANTED: { suffix: string; envVar: string }[] = [
    { suffix: '::intake::IntakeCap', envVar: 'INTAKE_CAP_ID' },
    { suffix: '::intake::IntakeConfig', envVar: 'INTAKE_CONFIG_ID' },
    { suffix: '::competition::CompetitionCap', envVar: 'COMPETITION_CAP_ID' },
];

async function main(): Promise<void> {
    try {
        process.loadEnvFile('.env');
    } catch {
        // No .env — rely on the ambient environment.
    }
    const network = (process.env.DATA_NETWORK ?? 'testnet') as WalrusNetwork;
    const packageId = required('QUADRA_PACKAGE_ID');
    const url = process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network);
    const client = new SuiJsonRpcClient({ network, url });

    // 1. The tx that created the package object IS the publish tx.
    const pkg = await client.getObject({ id: packageId, options: { showPreviousTransaction: true } });
    const digest = pkg.data?.previousTransaction;
    if (!digest) throw new Error(`could not resolve the publish tx for package ${packageId}`);

    // 2. Its created objects carry the cap/config types.
    const tx = await client.getTransactionBlock({ digest, options: { showObjectChanges: true } });
    const changes = (tx.objectChanges ?? []) as { objectType?: string; objectId?: string }[];

    const lines: string[] = [];
    for (const { suffix, envVar } of WANTED) {
        const hit = changes.find((c) => c.objectType?.endsWith(suffix));
        if (hit?.objectId) lines.push(`${envVar}=${hit.objectId}`);
        else console.error(`WARN: no object of type *${suffix} found in publish ${digest}`);
    }

    console.log(`# from quadra publish ${digest}`);
    console.log(lines.join('\n'));
}

main().catch((err) => {
    console.error('print-ids failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
