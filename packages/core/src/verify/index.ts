/**
 * quadra-core/verify — the pure replay checks.
 *
 * Separate from the main entry so two very different consumers can each take only what they need:
 * the `quadra-verify` CLI, and a future in-browser "verify this settlement" button that must not
 * pull in the encryption or the scorer registry it does not use.
 *
 * Nothing here touches the chain. The caller fetches; this decides.
 */

export {
    verifyJob,
    verifyCompetition,
    parseReceipt,
    allPassed,
    countBy,
    type Check,
    type CheckStatus,
    type SettlementPath,
    type JobVerifyInput,
    type CompetitionVerifyInput,
} from './checks.js';
