import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { SealClient, SessionKey, type SealCompatibleClient } from '@mysten/seal';
import type { JsonValue, WalrusJsonClient } from 'walrus-json';

import type { JobResult, SealedResultBlob } from './types.js';
import type { JobResultsIndex } from './dbs/jobResultsIndex.js';
import { withWriteLock } from './writeLock.js';

/** Backdate the decryption SessionKey by this much so a local clock slightly AHEAD of the Seal
 * key servers does not make the key look future-dated (the servers reject that as "Session key
 * has expired"). Well within the key's TTL, so it never trips the local expiry check. */
const SESSION_KEY_BACKDATE_MS = 60_000;

/** Seal identity bytes for a job = the UTF-8 job id (matches `job_access::seal_approve`). */
function identityBytes(jobId: string): Uint8Array {
    return new TextEncoder().encode(jobId);
}

/** Hex string Seal uses as the encryption identity (no `0x` prefix). */
function identityHex(jobId: string): string {
    return Buffer.from(identityBytes(jobId)).toString('hex');
}

export interface JobResultsOptions {
    wj: WalrusJsonClient;
    seal: SealClient;
    sui: SealCompatibleClient;
    index: JobResultsIndex;
    quadraPackageId: string;
    jobAccessRegistryId: string;
    threshold: number;
    epochs: number;
    /** SessionKey lifetime in minutes for decryption (default 10). */
    sessionTtlMin?: number;
}

/**
 * Private job results (Seal + Walrus): the result JSON is encrypted under the
 * job's identity and stored as a Walrus blob, indexed by `job_id -> blobId`.
 * Only the job's user and agent can decrypt, enforced by `job_access::seal_approve`.
 * `store` (encrypt) needs no key; `decrypt` needs the user's/agent's own key, so
 * it runs client-side, not on the server.
 */
export class JobResults {
    #o: JobResultsOptions;

    constructor(options: JobResultsOptions) {
        this.#o = options;
    }

    /** Encrypt and store a result, then index it. */
    async store(result: JobResult): Promise<{ blobId: string }> {
        const data = new TextEncoder().encode(JSON.stringify(result));
        const { encryptedObject } = await this.#o.seal.encrypt({
            threshold: this.#o.threshold,
            packageId: this.#o.quadraPackageId,
            id: identityHex(result.job_id),
            data,
        });

        const blob: SealedResultBlob = {
            sealed: true,
            job_id: result.job_id,
            enc: Buffer.from(encryptedObject).toString('base64'),
        };
        // Lock covers only the blob write; index.set takes the lock itself.
        const { blobId } = await withWriteLock(this.#o.wj, () =>
            this.#o.wj.writeJson(blob as unknown as JsonValue, { epochs: this.#o.epochs }),
        );
        await this.#o.index.set(result.job_id, blobId);
        return { blobId };
    }

    /**
     * Store a pre-sealed envelope (the agent encrypted client-side). The gateway
     * never sees plaintext — it only writes the ciphertext blob and indexes it.
     */
    async storeSealed(sealed: SealedResultBlob): Promise<{ blobId: string }> {
        const { blobId } = await withWriteLock(this.#o.wj, () =>
            this.#o.wj.writeJson(sealed as unknown as JsonValue, { epochs: this.#o.epochs }),
        );
        await this.#o.index.set(sealed.job_id, blobId);
        return { blobId };
    }

    /** Fetch the raw sealed envelope for a job (ciphertext only, no key needed). */
    async fetchSealed(jobId: string): Promise<SealedResultBlob> {
        const blobId = await this.#o.index.get(jobId);
        if (!blobId) throw new Error(`No result indexed for job ${jobId}`);
        return (await this.#o.wj.readJson(blobId)) as unknown as SealedResultBlob;
    }

    /** Decrypt a job result. `requester` must be the job's user or agent. */
    async decrypt(jobId: string, requester: Signer): Promise<JobResult> {
        const sealed = await this.fetchSealed(jobId);
        const encrypted = Uint8Array.from(Buffer.from(sealed.enc, 'base64'));

        const fresh = await SessionKey.create({
            address: requester.toSuiAddress(),
            packageId: this.#o.quadraPackageId,
            ttlMin: this.#o.sessionTtlMin ?? 10,
            suiClient: this.#o.sui,
        });
        // Re-import with a backdated creationTimeMs BEFORE signing (the signed personal message
        // embeds the creation time), so a clock ahead of the key servers does not look future-dated.
        const exported = fresh.export();
        const sessionKey = SessionKey.import(
            { ...exported, creationTimeMs: exported.creationTimeMs - SESSION_KEY_BACKDATE_MS },
            this.#o.sui,
        );
        const { signature } = await requester.signPersonalMessage(sessionKey.getPersonalMessage());
        await sessionKey.setPersonalMessageSignature(signature);

        const txBytes = await this.#buildApproveTx(jobId);
        const data = await this.#o.seal.decrypt({ data: encrypted, sessionKey, txBytes });
        return JSON.parse(new TextDecoder().decode(data)) as JobResult;
    }

    /** Transaction bytes that call `seal_approve(id, registry)` for the key servers. */
    async #buildApproveTx(jobId: string): Promise<Uint8Array> {
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.#o.quadraPackageId}::job_access::seal_approve`,
            arguments: [
                tx.pure.vector('u8', Array.from(identityBytes(jobId))),
                tx.object(this.#o.jobAccessRegistryId),
            ],
        });
        return tx.build({ client: this.#o.sui, onlyTransactionKind: true });
    }
}
