import type { WalrusJsonClient } from 'walrus-json';

import type { JobSchedulerDoc } from '../types.js';
import { PointerDoc } from './base.js';

export const EMPTY_JOB_SCHEDULER: JobSchedulerDoc = { jobs: {}, updated_at: 0 };

/** One scheduled job and when it expires (epoch ms). */
export interface ScheduledJob {
    job_id: string;
    expires_at: number;
}

/**
 * Job scheduler (Walrus, public): a `job_id -> expiry` table. The scheduler
 * engine lists everything each epoch and acts on the entries that are due.
 */
export class JobScheduler extends PointerDoc<JobSchedulerDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** Every scheduled job with its expiry. */
    async list(): Promise<ScheduledJob[]> {
        const { jobs } = await this.read();
        return Object.entries(jobs).map(([job_id, expires_at]) => ({ job_id, expires_at }));
    }

    /** Jobs whose expiry is at or before `now` (default: current time). */
    async due(now: number = Date.now()): Promise<ScheduledJob[]> {
        return (await this.list()).filter((j) => j.expires_at <= now);
    }

    /** Schedule (or reschedule) a job's expiry. */
    async set(jobId: string, expiresAt: number): Promise<void> {
        await this.update((doc) => {
            doc.jobs[jobId] = expiresAt;
            doc.updated_at = Date.now();
            return doc;
        });
    }

    /** Remove a job once it has been handled. */
    async remove(jobId: string): Promise<void> {
        await this.update((doc) => {
            delete doc.jobs[jobId];
            doc.updated_at = Date.now();
            return doc;
        });
    }

    /** Remove several jobs in a single write. */
    async removeMany(jobIds: string[]): Promise<void> {
        if (jobIds.length === 0) return;
        await this.update((doc) => {
            for (const id of jobIds) delete doc.jobs[id];
            doc.updated_at = Date.now();
            return doc;
        });
    }
}
