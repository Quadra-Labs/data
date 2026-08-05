/**
 * client.ts — one viem client factory.
 *
 * The Flare reference defined an identical `makeClient` in three separate chain modules. Each
 * created its own client, so three readers on one page opened three connections and shared no
 * request coalescing at all. One factory, one client per process.
 *
 * The chain is defined synthetically rather than imported from a chain list: the tool then works
 * against Coston2, a local anvil, or mainnet without a list to keep current.
 */

import { createPublicClient, http as viemHttp, defineChain, type PublicClient } from 'viem';

export interface ChainEndpoint {
    readonly rpcUrl: string;
    readonly chainId: number;
}

export function makeClient(endpoint: ChainEndpoint): PublicClient {
    const chain = defineChain({
        id: endpoint.chainId,
        name: `chain-${endpoint.chainId}`,
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
        rpcUrls: { default: { http: [endpoint.rpcUrl] } },
    });
    return createPublicClient({ chain, transport: viemHttp(endpoint.rpcUrl) }) as PublicClient;
}
