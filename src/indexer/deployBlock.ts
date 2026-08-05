/**
 * deployBlock.ts — find the block a contract was deployed in.
 *
 * Without a floor, a cold index starts at genesis. On Coston2 that is ~33.6 million blocks, and at
 * 30 blocks per `eth_getLogs` window it is over a million requests — the public endpoint throttles
 * it long before it finishes, so the index never becomes usable at all.
 *
 * `contracts/deployments/<chainId>.json` does not record the deploy block, and adding it would
 * only help deployments made after that change. Binary search over `eth_getCode` finds it for any
 * deployment, past or future, in about 25 requests: code is absent before the deploy and present
 * from it onward, so the boundary is exactly the deploy block.
 *
 * The answer is cached in the index's `meta` table, so this runs once per database rather than
 * once per restart.
 */

import type { Address, PublicClient } from 'viem';

export interface DeployBlockOptions {
    readonly client: PublicClient;
    /** Every watched contract. The earliest deploy among them is the floor. */
    readonly addresses: readonly Address[];
    /** Called with progress, since ~25 sequential round trips is a visible pause. */
    readonly onProbe?: ((address: Address, block: bigint) => void) | undefined;
}

/** True once `address` has code at `block`. */
async function hasCode(
    client: PublicClient,
    address: Address,
    blockNumber: bigint,
): Promise<boolean> {
    const code = await client.getCode({ address, blockNumber });
    return code !== undefined && code !== '0x';
}

/**
 * The block `address` was deployed in, or undefined if it has no code at the head — which means
 * either a wrong address or a contract that was destroyed.
 */
export async function findDeployBlock(
    client: PublicClient,
    address: Address,
    head?: bigint,
): Promise<bigint | undefined> {
    const tip = head ?? (await client.getBlockNumber());
    if (!(await hasCode(client, address, tip))) return undefined;

    let lo = 0n;
    let hi = tip;
    // Invariant: no code at `lo`, code at `hi`. Narrow until they meet; `hi` is the answer.
    while (lo + 1n < hi) {
        const mid = (lo + hi) / 2n;
        if (await hasCode(client, address, mid)) hi = mid;
        else lo = mid;
    }
    return hi;
}

/**
 * The earliest deploy block across every watched contract.
 *
 * The earliest, not the latest: they were deployed in one script but not necessarily one block,
 * and starting after any of them would miss that contract's first events.
 */
export async function findEarliestDeployBlock(
    opts: DeployBlockOptions,
): Promise<bigint | undefined> {
    const head = await opts.client.getBlockNumber();
    let earliest: bigint | undefined;
    for (const address of opts.addresses) {
        const found = await findDeployBlock(opts.client, address, head);
        if (found === undefined) continue;
        opts.onProbe?.(address, found);
        if (earliest === undefined || found < earliest) earliest = found;
    }
    return earliest;
}
