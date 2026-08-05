/**
 * teeRegistry.ts — who is allowed to settle, and what code they are running.
 *
 * This replaces the Sui `eval_engines` catalog: a mutable Walrus document mapping evaluator ids to
 * enclave URLs, which an operator could edit at any time. On Flare there is no routing table. One
 * registered TEE settles everything, its address is on chain, and both markets check every
 * settlement against it. A catalog cannot be edited into accepting a different signer.
 *
 * Cached, because three different callers ask for the same three values on nearly every request
 * and none of them changes between registrations.
 */

import type { Address, Hex, PublicClient } from 'viem';

import { teeRegistryAbi } from './abis.js';
import { Cached } from '../cache.js';

export interface TeeIdentity {
    /** The address every settlement signature must recover to. Zero when none is registered. */
    readonly wallet: Address;
    /** The secp256k1 public key agents ECIES-seal submissions to. Empty when unregistered. */
    readonly publicKey: Hex;
    /** The container image digest a receipt must name to be trustworthy. */
    readonly imageDigest: string;
    /** True once the active TEE was bound through Flare Confidential Compute. */
    readonly fccMode: boolean;
    /** False when nothing is registered, in which case NOTHING can settle. */
    readonly registered: boolean;
}

const ZERO = '0x0000000000000000000000000000000000000000' as const;

export const NO_TEE: TeeIdentity = {
    wallet: ZERO,
    publicKey: '0x',
    imageDigest: '',
    fccMode: false,
    registered: false,
};

export interface TeeRegistryReader {
    /** The active TEE, cached. Never throws — an unreachable chain reads as unregistered. */
    identity(): Promise<TeeIdentity>;
    /** Force a re-read, for after a registration. */
    refresh(): Promise<TeeIdentity>;
}

export function makeTeeRegistryReader(
    client: PublicClient,
    teeRegistry: Address,
    ttlMs: number,
): TeeRegistryReader {
    const cache = new Cached<TeeIdentity>(async () => {
        const [wallet, publicKey, imageDigest, fccMode] = await Promise.all([
            client.readContract({
                address: teeRegistry,
                abi: teeRegistryAbi,
                functionName: 'activeTeeWallet',
            }),
            client.readContract({
                address: teeRegistry,
                abi: teeRegistryAbi,
                functionName: 'activeTeePublicKey',
            }),
            client
                .readContract({
                    address: teeRegistry,
                    abi: teeRegistryAbi,
                    functionName: 'expectedImageDigest',
                })
                .catch(() => ''),
            client
                .readContract({
                    address: teeRegistry,
                    abi: teeRegistryAbi,
                    functionName: 'fccMode',
                })
                .catch(() => false),
        ]);
        return {
            wallet,
            publicKey,
            imageDigest,
            fccMode,
            // A zero wallet is the state today (see DEPLOYMENT-STATE.md, Gap 1) and it means
            // every settlement path reverts BadTeeSignature, because no signature recovers to
            // the zero address. Worth surfacing as its own flag rather than making each caller
            // compare against a zero constant.
            registered: wallet !== ZERO,
        };
    }, { ttlMs });

    return {
        async identity() {
            try {
                return await cache.get();
            } catch {
                return NO_TEE;
            }
        },
        async refresh() {
            try {
                return await cache.prime();
            } catch {
                return NO_TEE;
            }
        },
    };
}
