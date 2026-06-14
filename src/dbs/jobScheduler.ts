import type { WalrusJsonClient } from 'walrus-json';

import type { JobSchedulerDoc, JobStart } from '../types.js';
import { PointerDoc } from './base.js';

export const EMPTY_JOB_SCHEDULER: JobSchedulerDoc = { jobs: {}, start_data: {}, updated_at: 0 };

/** One scheduled job and when it expires (epoch ms). */
export interface ScheduledJob {
    job_id: string;
    expires_at: number;
}

/**
 * Job scheduler (Walrus, public): a `job_id -> expiry` table plus a parallel
 * `job_id -> start data` map. The scheduler engine lists everything each epoch,
 * acts on the entries that are due, and reads the start data to score against
 * the price captured at delivery.
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

    /** The start data captured for a job at delivery, if any. */
    async getStart(jobId: string): Promise<JobStart | undefined> {
        return (await this.read()).start_data?.[jobId];
    }

    /** Schedule (or reschedule) a job's expiry, optionally with its start data. */
    async set(jobId: string, expiresAt: number, start?: JobStart): Promise<void> {
        await this.update((doc) => {
            doc.start_data ??= {}; // pointers created before start_data existed
            doc.jobs[jobId] = expiresAt;
            if (start) doc.start_data[jobId] = start;
            doc.updated_at = Date.now();
            return doc;
        });
    }

    /** Remove a job (and its start data) once it has been handled. */
    async remove(jobId: string): Promise<void> {
        await this.update((doc) => {
            doc.start_data ??= {};
            delete doc.jobs[jobId];
            delete doc.start_data[jobId];
            doc.updated_at = Date.now();
            return doc;
        });
    }

    /** Remove several jobs (and their start data) in a single write. */
    async removeMany(jobIds: string[]): Promise<void> {
        if (jobIds.length === 0) return;
        await this.update((doc) => {
            doc.start_data ??= {};
            for (const id of jobIds) {
                delete doc.jobs[id];
                delete doc.start_data[id];
            }
            doc.updated_at = Date.now();
            return doc;
        });
    }
}
