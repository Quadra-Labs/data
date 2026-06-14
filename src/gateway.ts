import type { AgentScore, FailedJob, JobStart, JobTemplate, SealedResultBlob } from './types.js';

export interface GatewayClientOptions {
    /** Base URL of the data gateway (e.g. http://localhost:8787). */
    url: string;
    /** This engine's role token (sent as `x-quadra-role`). */
    roleToken: string;
}

/**
 * Typed HTTP client engines use to WRITE through the data gateway instead of
 * touching Walrus directly. Each call carries the engine's role token; the
 * gateway enforces which role may write which database.
 *
 * Reads stay on the data layer library (public) — this client is writes only.
 */
export class GatewayClient {
    #url: string;
    #roleToken: string;

    constructor(options: GatewayClientOptions) {
        this.#url = options.url.replace(/\/$/, '');
        this.#roleToken = options.roleToken;
    }

    /** Fold a delivered job's score into the agent's running average. */
    recordScore(wallet: string, score: number): Promise<AgentScore> {
        return this.#send('POST', '/agent-scores/record', { wallet, score });
    }

    /** Append an entry to the delayed/failed jobs log. */
    addFailure(entry: Omit<FailedJob, 'at'>): Promise<FailedJob> {
        return this.#send('POST', '/delayed-failed', entry);
    }

    /** Schedule (or reschedule) a job's lifetime expiry, optionally with the
     * start data captured at delivery. */
    scheduleJob(jobId: string, expiresAt: number, start?: JobStart): Promise<{ ok: true }> {
        return this.#send('PUT', `/scheduler/${encodeURIComponent(jobId)}`, {
            expires_at: expiresAt,
            ...(start ? { start } : {}),
        });
    }

    /** Remove a job from the scheduler once handled. */
    removeJob(jobId: string): Promise<{ ok: true }> {
        return this.#send('DELETE', `/scheduler/${encodeURIComponent(jobId)}`);
    }

    /** Create or replace a job template (admin role). */
    putTemplate(template: JobTemplate): Promise<JobTemplate> {
        return this.#send('PUT', '/templates', template);
    }

    /** Store an already-sealed result envelope (admin role; agents use signatures). */
    storeSealedResult(sealed: SealedResultBlob): Promise<{ blobId: string }> {
        return this.#send('POST', '/job-results', sealed);
    }

    async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${this.#url}${path}`, {
            method,
            headers: {
                'content-type': 'application/json',
                'x-quadra-role': this.#roleToken,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`gateway ${method} ${path} -> ${res.status} ${text}`);
        }
        return (await res.json()) as T;
    }
}
