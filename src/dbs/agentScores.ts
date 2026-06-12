import type { WalrusJsonClient } from 'walrus-json';

import type { AgentScore, AgentScoresDoc } from '../types.js';
import { PointerDoc } from './base.js';

/** Empty initial document, used by `bootstrap`. */
export const EMPTY_AGENT_SCORES: AgentScoresDoc = { agents: {}, updated_at: 0 };

/**
 * Agent performance scores (Walrus, public). Each agent's score is an
 * equal-weight running average of every job it has delivered.
 */
export class AgentScores extends PointerDoc<AgentScoresDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** Read one agent's score, or `undefined` if it has none yet. */
    async get(wallet: string): Promise<AgentScore | undefined> {
        return (await this.read()).agents[wallet];
    }

    /**
     * Fold a newly delivered job's score (0-100) into an agent's running average:
     * `newScore = (score * total + jobScore) / (total + 1)`, then `total += 1`.
     */
    async recordJob(wallet: string, jobScore: number): Promise<AgentScore> {
        if (jobScore < 0 || jobScore > 100) {
            throw new Error(`jobScore must be in [0, 100], got ${jobScore}`);
        }
        let updated!: AgentScore;
        await this.update((doc) => {
            const prev = doc.agents[wallet] ?? { wallet, score: 0, total_jobs_delivered: 0 };
            const total = prev.total_jobs_delivered;
            const score = Math.round((prev.score * total + jobScore) / (total + 1));
            updated = { wallet, score, total_jobs_delivered: total + 1 };
            doc.agents[wallet] = updated;
            doc.updated_at = Date.now();
            return doc;
        });
        return updated;
    }
}
