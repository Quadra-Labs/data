/**
 * print-addresses.ts — what this deployment is pointed at, and whether it is real.
 *
 * The Sui equivalent recovered object ids from a publish transaction. Here the addresses come from
 * `contracts/deployments/<chainId>.json`, so the useful work is not finding them but CHECKING
 * them: an address that holds no code is a typo or a wrong chain, and the symptom otherwise is
 * every call reverting for no stated reason.
 *
 *     pnpm print-addresses
 */

import '../src/boot.js';

import { loadConfig, explainMissing, addressUrl } from '../src/config.js';
import { makeClient } from '../src/chain/client.js';
import { findEarliestDeployBlock } from '../src/indexer/deployBlock.js';
import { makeTeeRegistryReader } from '../src/chain/teeRegistry.js';
import { loadCatalog } from '../src/agents/catalog.js';

async function main(): Promise<void> {
    const loaded = loadConfig();
    if (!loaded.ok) {
        console.error(explainMissing(loaded.missing, Number(process.env['CHAIN_ID'] ?? 114)));
        process.exitCode = 1;
        return;
    }
    const cfg = loaded.config;
    const client = makeClient(cfg);

    console.log(`chain     ${cfg.chainId}`);
    console.log(`rpc       ${cfg.rpcUrl}`);
    console.log(`addresses ${loaded.source.deploymentFile ? 'contracts/deployments' : 'environment'}`);
    console.log('');

    const contracts: ReadonlyArray<readonly [string, string]> = [
        ['JobEscrow', cfg.jobEscrow],
        ['SealedCompetition', cfg.sealedCompetition],
        ['Passport', cfg.passport],
        ['TeeRegistry', cfg.teeRegistry],
        ...(cfg.quadraToken ? ([['QuadraToken', cfg.quadraToken]] as const) : []),
    ];

    let allDeployed = true;
    for (const [name, address] of contracts) {
        const code = await client
            .getCode({ address: address as `0x${string}` })
            .catch(() => undefined);
        const deployed = code !== undefined && code !== '0x';
        if (!deployed) allDeployed = false;
        console.log(`${deployed ? 'ok  ' : 'MISSING'} ${name.padEnd(18)} ${address}`);
        console.log(`     ${addressUrl(cfg.explorer, address)}`);
    }

    if (!allDeployed) {
        console.log('\nAt least one address holds no code — wrong chain, or a stale deployment file.');
        process.exitCode = 1;
        return;
    }

    console.log('');
    const deployBlock = await findEarliestDeployBlock({ client, addresses: contracts.map(([, a]) => a as `0x${string}`) });
    console.log(`deploy block  ${deployBlock ?? 'unknown'}  (the indexer's floor)`);
    console.log(`chain head    ${await client.getBlockNumber()}`);

    const tee = await makeTeeRegistryReader(client, cfg.teeRegistry, 0).identity();
    console.log('');
    console.log(`TEE registered  ${tee.registered}`);
    console.log(`TEE wallet      ${tee.wallet}`);
    console.log(`image digest    "${tee.imageDigest}"`);
    if (!tee.registered) {
        console.log('  → nothing can settle until this is bound (DEPLOYMENT-STATE.md, Gap 1)');
    }
    if (tee.imageDigest === 'sha256:dev') {
        console.log('  → the image digest is still a placeholder (DEPLOYMENT-STATE.md, Gap 3)');
    }

    const catalog = loadCatalog();
    console.log('');
    console.log(`agents in the catalog: ${catalog.length}`);
    for (const a of catalog) {
        console.log(`  ${a.slug.padEnd(16)} ${a.wallet ?? '(no wallet configured)'}`);
    }
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
