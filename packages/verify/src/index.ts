/**
 * quadra-verify — re-derive a settlement from chain data alone.
 *
 * Exported as a library as well as a binary so the sandbox and any future "verify" button can run
 * the same checks in-process, rather than shelling out and parsing text.
 */

export {
    verifyJobById,
    verifyCompetitionById,
    printChecks,
    type VerifyOptions,
} from './verify.js';
export {
    makeVerifyFetcher,
    blockOfTx,
    type VerifyFetcher,
    type VerifyChainConfig,
    type FetchedSettlement,
    type RegisteredTee,
} from './fetch.js';
export { loadDeployment, type Deployment } from './addresses.js';
export { jobEscrowVerifyAbi, sealedCompetitionVerifyAbi, teeRegistryVerifyAbi } from './abis.js';
