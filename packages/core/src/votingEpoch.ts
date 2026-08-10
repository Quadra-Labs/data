/**
 * votingEpoch.ts — resolve the FTSO voting-epoch geometry from chain instead of trusting a literal.
 *
 * `feeds.ts` compiles in `FIRST_VOTING_ROUND_UNIX = 1658430000` and `VOTING_EPOCH_SECS = 90`. Those
 * are confirmed correct against live Coston2, but they are a literal in a file, and Flare's own
 * documentation publishes `1658429955` for a sibling network. The authority is
 * `FlareSystemsManager`, resolved through the contract registry — the one address in the Flare
 * family that is safe to hardcode, because it is identical on every network in it.
 *
 * WHY THIS IS WORTH A CHAIN CALL. If the geometry is ever wrong, nothing reports an error:
 * `votingRoundIdForTimestamp` returns a plausible round, the DA layer answers with a real finalized
 * feed, the Merkle proof verifies on chain, and the settlement is scored against the wrong instant.
 * Every layer of the "double verification" story passes while the answer is wrong.
 *
 * WHY IT NEVER THROWS. Booting the indexer must not start depending on a protocol contract being
 * reachable — that trades a silent wrong answer for a loud outage, which is not obviously a better
 * deal for a demo. So a failure logs and falls back to the compiled-in values, and a DIVERGENCE
 * logs loudly, because that is the case the literal is actually wrong.
 *
 * It lives in its own `quadra-core/voting-epoch` entry rather than in the root, so `feeds.ts` stays
 * I/O-free — the enclave image and the verifier both import that, and a verifier that dials out to
 * the chain it is auditing is a weaker verifier.
 */

import { parseAbi, type Address, type PublicClient } from 'viem';

import { FALLBACK_VOTING_EPOCH, type VotingEpoch } from './feeds.js';

/** Identical on Flare, Songbird, Coston and Coston2. The answers vary; the address does not. */
export const FLARE_CONTRACT_REGISTRY: Address = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';

const REGISTRY_ABI = parseAbi([
    'function getContractAddressByName(string _name) view returns (address)',
]);

const SYSTEMS_MANAGER_ABI = parseAbi([
    'function firstVotingRoundStartTs() view returns (uint64)',
    'function votingEpochDurationSeconds() view returns (uint64)',
    'function getCurrentVotingEpochId() view returns (uint32)',
]);

export interface ResolvedVotingEpoch {
    readonly epoch: VotingEpoch;
    /** False when the chain could not answer and the compiled-in values are in use. */
    readonly fromChain: boolean;
    /** Present when the chain disagreed with the fallback, or when the read failed. */
    readonly warning?: string;
}

type Reader = Pick<PublicClient, 'readContract'>;

/**
 * Read `firstVotingRoundStartTs` / `votingEpochDurationSeconds` from `FlareSystemsManager`.
 *
 * Never throws. On any failure the fallback is returned with a warning attached, so the caller
 * decides how loud to be and boot liveness is unchanged.
 */
export async function resolveVotingEpoch(client: Reader): Promise<ResolvedVotingEpoch> {
    try {
        const manager = (await client.readContract({
            address: FLARE_CONTRACT_REGISTRY,
            abi: REGISTRY_ABI,
            functionName: 'getContractAddressByName',
            args: ['FlareSystemsManager'],
        })) as Address;

        if (!manager || manager === '0x0000000000000000000000000000000000000000') {
            return fallback('the contract registry does not know "FlareSystemsManager" on this chain');
        }

        const [firstTs, duration] = await Promise.all([
            client.readContract({
                address: manager,
                abi: SYSTEMS_MANAGER_ABI,
                functionName: 'firstVotingRoundStartTs',
            }) as Promise<bigint>,
            client.readContract({
                address: manager,
                abi: SYSTEMS_MANAGER_ABI,
                functionName: 'votingEpochDurationSeconds',
            }) as Promise<bigint>,
        ]);

        const epoch: VotingEpoch = {
            firstVotingRoundUnix: Number(firstTs),
            epochSecs: Number(duration),
        };

        // A zero duration would make every round id a division by zero; a zero start would place
        // round 0 in 1970. Either means we read something that is not the manager.
        if (epoch.epochSecs <= 0 || epoch.firstVotingRoundUnix <= 0) {
            return fallback(
                `FlareSystemsManager at ${manager} answered with an unusable epoch ` +
                    `(start=${epoch.firstVotingRoundUnix}, duration=${epoch.epochSecs})`,
            );
        }

        const drifted =
            epoch.firstVotingRoundUnix !== FALLBACK_VOTING_EPOCH.firstVotingRoundUnix ||
            epoch.epochSecs !== FALLBACK_VOTING_EPOCH.epochSecs;

        return {
            epoch,
            fromChain: true,
            ...(drifted
                ? {
                      warning:
                          `the chain's voting epoch differs from the compiled-in fallback: chain says ` +
                          `start=${epoch.firstVotingRoundUnix} duration=${epoch.epochSecs}, code says ` +
                          `start=${FALLBACK_VOTING_EPOCH.firstVotingRoundUnix} ` +
                          `duration=${FALLBACK_VOTING_EPOCH.epochSecs}. The chain wins here, but every ` +
                          `OTHER copy of these numbers is now wrong — update feeds.ts`,
                  }
                : {}),
        };
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return fallback(`could not read FlareSystemsManager (${detail})`);
    }
}

function fallback(why: string): ResolvedVotingEpoch {
    return {
        epoch: FALLBACK_VOTING_EPOCH,
        fromChain: false,
        warning: `${why}; using the compiled-in Coston2 voting epoch instead`,
    };
}

export { FALLBACK_VOTING_EPOCH, type VotingEpoch };
