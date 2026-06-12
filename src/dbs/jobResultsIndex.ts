import type { WalrusJsonClient } from 'walrus-json';

import type { JobResultsIndexDoc } from '../types.js';
import { PointerDoc } from './base.js';

export const EMPTY_JOB_RESULTS_INDEX: JobResultsIndexDoc = { results: {}, updated_at: 0 };

/**
 * Public index mapping `job_id -> blobId` of each sealed result. It leaks which
 * jobs exist, never their contents, so results are discoverable without a key.
 */
export class JobResultsIndex extends PointerDoc<JobResultsIndexDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** The blob id of a job's sealed result, if stored. */
    async get(jobId: string): Promise<string | undefined> {
        return (await this.read()).results[jobId];
    }

    /** Point a job id at its sealed-result blob. */
    async set(jobId: string, blobId: string): Promise<void> {
        await this.update((doc) => {
            doc.results[jobId] = blobId;
            doc.updated_at = Date.now();
            return doc;
        });
    }
}
