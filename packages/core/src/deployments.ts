/**
 * deployments.ts — where the contract addresses come from.
 *
 * `contracts/deployments/<chainId>.json` is the source of truth, written by the deploy script.
 * Reading it means a redeploy needs no config change anywhere, which is the whole reason the
 * markets can be redeployed cheaply before submission. Environment variables override it, for the
 * case where someone is pointing a tool at a deployment they did not run.
 *
 * The file is looked up relative to this package, assuming the sibling-checkout layout the Quadra
 * repos already use (`data/` and `contracts/` next to each other). If it is not there, env alone
 * is enough — the file is a convenience, never a requirement.
 *
 * This touches the filesystem, so it ships behind the `quadra-core/deployments` subpath rather
 * than the pure entry point, for the same reason `ground-truth` does.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

export interface Deployment {
    readonly chainId: number;
    readonly teeRegistry?: Address;
    readonly jobEscrow?: Address;
    readonly sealedCompetition?: Address;
    readonly passport?: Address;
    readonly quadraToken?: Address;
    readonly evaluationInstructionSender?: string;
    readonly fromBlock?: number;
}

/** Candidate locations for the deployments directory, nearest first. */
function candidates(): string[] {
    const here = dirname(fileURLToPath(import.meta.url));
    const fromEnv = process.env['CONTRACTS_DIR'];
    return [
        ...(fromEnv ? [join(fromEnv, 'deployments')] : []),
        // packages/core/{src,dist} -> packages/core -> packages -> data -> <parent>/contracts
        resolve(here, '..', '..', '..', '..', 'contracts', 'deployments'),
        resolve(process.cwd(), '..', 'contracts', 'deployments'),
        resolve(process.cwd(), 'contracts', 'deployments'),
    ];
}

/** Read `contracts/deployments/<chainId>.json`, or undefined if it is not reachable. */
export function loadDeployment(chainId: number): Deployment | undefined {
    for (const dir of candidates()) {
        try {
            const raw = readFileSync(join(dir, `${chainId}.json`), 'utf8');
            const parsed = JSON.parse(raw) as Deployment;
            // A deployment file for the wrong chain is worse than none: it would point the
            // verifier at addresses that do not exist and report every check as failed.
            if (parsed.chainId === chainId) return parsed;
        } catch {
            // Try the next candidate; a missing file is normal, not an error.
        }
    }
    return undefined;
}
