import type { WalrusJsonClient } from 'walrus-json';

import type { DelayedFailedJobsDoc, FailedJob, FailureKind } from '../types.js';
import { PointerDoc } from './base.js';

export const EMPTY_DELAYED_FAILED: DelayedFailedJobsDoc = { jobs: [], updated_at: 0 };

/**
 * Delayed & failed jobs log (Walrus, public). Written when the evaluation engine
 * returns an error or a job misses its window.
 */
export class DelayedFailedJobs extends PointerDoc<DelayedFailedJobsDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** All logged entries, newest last. */
    async list(): Promise<FailedJob[]> {
        return (await this.read()).jobs;
    }

    /** Append a failure record. */
    async add(input: {
        job_id: string;
        agent?: string | null;
        kind: FailureKind;
        reason: string;
    }): Promise<FailedJob> {
        const entry: FailedJob = {
            job_id: input.job_id,
            agent: input.agent ?? null,
            kind: input.kind,
            reason: input.reason,
            at: Date.now(),
        };
        await this.update((doc) => {
            doc.jobs.push(entry);
            doc.updated_at = Date.now();
            return doc;
        });
        return entry;
    }
}
