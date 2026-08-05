/**
 * catalog.ts — who the agents are.
 *
 * Flare has no on-chain agent registry. Quadra had one (`agent::AgentRegistry`) and it was dropped
 * deliberately: on an EVM the wallet IS the identity, and a registry contract adds a write path,
 * a gas cost and an admin surface to store a display name.
 *
 * The consequence is that `name`, `description` and `owner` have no chain source, so they come
 * from this checked-in file. Everything that matters — every score, every payment, every
 * settlement — still comes from the chain. Be honest about the split when describing it: the
 * marketplace is operator-curated, and only the reputation is trustless.
 *
 * Wallets are resolved from the environment rather than hardcoded, because they differ per
 * deployment. They are per-agent on purpose: reputation is keyed by wallet, so three agents
 * sharing one key would share one Passport track and no leaderboard could ever separate them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

import { categoryOf } from '../chain/passport.js';

export interface CatalogAgent {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly evaluatorId: string;
    readonly asset: string;
    readonly priceWei: bigint;
    /** The wallet, when the environment supplies one. Absent means "listed but not deployed". */
    readonly wallet: Address | undefined;
    readonly scoreless: boolean;
    /** keccak(evaluatorId) — the Passport dimension this agent is scored in. */
    readonly category: string;
}

interface RawAgent {
    slug: string;
    name: string;
    description: string;
    evaluatorId: string;
    asset: string;
    priceWei: string;
    addressEnv: string;
    scoreless?: boolean;
}

function catalogPath(): string {
    // The JSON sits beside this module in src, and beside the bundle in dist.
    return join(dirname(fileURLToPath(import.meta.url)), 'catalog.json');
}

/**
 * Read the catalog and resolve each wallet from the environment.
 *
 * Never throws: a missing or malformed catalog costs display names, not correctness, and a
 * gateway that refuses to start because a description file is absent is worse than one that
 * serves addresses without names.
 */
export function loadCatalog(path = catalogPath()): CatalogAgent[] {
    let raw: { agents?: RawAgent[] };
    try {
        raw = JSON.parse(readFileSync(path, 'utf8')) as { agents?: RawAgent[] };
    } catch {
        return [];
    }
    return (raw.agents ?? []).map((a) => {
        const env = (process.env[a.addressEnv] ?? '').trim();
        return {
            slug: a.slug,
            name: a.name,
            description: a.description,
            evaluatorId: a.evaluatorId,
            asset: a.asset,
            priceWei: BigInt(a.priceWei || '0'),
            wallet: env.length > 0 ? (env as Address) : undefined,
            scoreless: a.scoreless === true,
            category: categoryOf(a.evaluatorId),
        };
    });
}

/** The agents with a configured wallet — the only ones that can appear on chain. */
export function deployedAgents(catalog: readonly CatalogAgent[]): CatalogAgent[] {
    return catalog.filter((a) => a.wallet !== undefined);
}
