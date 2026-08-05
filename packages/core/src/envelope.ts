/**
 * envelope.ts — dual-reader encryption for PAID-JOB results.
 *
 * A paid result must be readable by exactly two parties: the paying USER (it is their alpha) and
 * the TEE (which has to score it) — never the operator, and never the marketplace. So the agent
 * encrypts the result once under a random symmetric key K (AES-256-GCM), then ECIES-wraps K to
 * the user's key AND to the TEE's key. Either private key recovers K and decrypts; nobody else
 * can.
 *
 * This replaces Sui's Seal: there, "only the user or the agent may read" was enforced ON CHAIN by
 * `job_access::seal_approve` and a threshold of key servers. Here it is enforced
 * CRYPTOGRAPHICALLY — only two wraps exist, so no contract check is needed and no key server is
 * trusted. Note what is given up along with the key servers: the TEE wrap is single-party, so
 * there is no threshold and no recovery if the TEE key is lost.
 *
 * Competition submissions do NOT use this; they are sealed to the TEE alone. This envelope is
 * only the paid-job dual-reader case.
 *
 * Uses node:crypto for the AES step. A browser reader would swap in WebCrypto — note that
 * WebCrypto expects the GCM tag APPENDED to the ciphertext while this format stores `ct` and
 * `tag` separately, so that adapter must concatenate. The wire format stays identical.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { keccak256, toHex, type Hex } from 'viem';

import { toBytes } from './hex.js';
import { openTeeKey, openUserKey, sealToTeeKey, sealToUserKey } from './ecies.js';

/** The on-wire envelope. All fields hex; `ct` is the AES-GCM ciphertext of the JSON payload. */
export interface Envelope {
    readonly v: 1;
    readonly iv: Hex;
    readonly ct: Hex;
    readonly tag: Hex;
    /** K, ECIES-wrapped to the user's public key (eciesjs). */
    readonly encKUser: Hex;
    /** K, ECIES-wrapped to the TEE's public key (geth-ECIES). */
    readonly encKTee: Hex;
}

export interface SealedEnvelope {
    readonly envelope: Envelope;
    /** The serialized envelope, as the calldata argument to JobEscrow.deliver. */
    readonly ciphertext: Hex;
    /** keccak(ciphertext) — the on-chain delivery commitment. */
    readonly ciphertextHash: Hex;
}

/**
 * Unwraps one ECIES blob, or returns undefined if this reader cannot open it.
 *
 * Injected rather than called directly so the enclave can route the unwrap through the TEE node's
 * /decrypt endpoint without the extension ever holding a key.
 */
export type Unwrap = (wrapped: Hex) => Promise<Uint8Array | undefined>;

/** Encrypt `payload` so that ONLY the user and the TEE can read it. */
export async function sealEnvelope(
    userPublicKey: string,
    teePublicKey: string,
    payload: unknown,
): Promise<SealedEnvelope> {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const k = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: Envelope = {
        v: 1,
        iv: toHex(iv),
        ct: toHex(ct),
        tag: toHex(tag),
        encKUser: sealToUserKey(userPublicKey, k),
        encKTee: await sealToTeeKey(teePublicKey, k),
    };
    const ciphertext = toHex(Buffer.from(JSON.stringify(envelope), 'utf8'));
    return { envelope, ciphertext, ciphertextHash: keccak256(ciphertext) };
}

function parse(ciphertext: Hex): Envelope {
    return JSON.parse(toBytes(ciphertext).toString('utf8')) as Envelope;
}

/** Decrypt the AES-GCM body once a reader has recovered K. */
function openBody(env: Envelope, k: Uint8Array): Record<string, string> {
    const decipher = createDecipheriv('aes-256-gcm', k, toBytes(env.iv));
    decipher.setAuthTag(toBytes(env.tag));
    const plain = Buffer.concat([decipher.update(toBytes(env.ct)), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, string>;
}

/** Open an envelope as the paying USER. Reads only the user's wrap. Throws if this key is not it. */
export function openEnvelope(privateKey: string, ciphertext: Hex): Record<string, string> {
    const env = parse(ciphertext);
    const k = openUserKey(privateKey, env.encKUser);
    if (!k) throw new Error('envelope: this key cannot open the user wrap');
    return openBody(env, k);
}

/**
 * Open an envelope as the TEE, through an injected unwrapper.
 *
 * Reads ONLY `encKTee`, never the user's wrap. That was always the intent; making it structural
 * matters more under FCC, where the unwrap is a call to the TEE node and a stray attempt on the
 * user's blob would be a request to decrypt someone else's secret.
 */
export async function openEnvelopeAsTee(
    unwrap: Unwrap,
    ciphertext: Hex,
): Promise<Record<string, string>> {
    const env = parse(ciphertext);
    const k = await unwrap(env.encKTee);
    if (!k) throw new Error('envelope: the TEE wrap could not be opened');
    return openBody(env, k);
}

/**
 * Open as the TEE when the enclave holds a raw private key — the self-operated path and the local
 * simulated stack. Under FCC this is replaced by a node-backed `openEnvelopeAsTee`.
 */
export async function openEnvelopeWithTeeKey(
    privateKey: string,
    ciphertext: Hex,
): Promise<Record<string, string>> {
    return openEnvelopeAsTee(async (wrapped) => {
        try {
            return await openTeeKey(privateKey, wrapped);
        } catch {
            return undefined;
        }
    }, ciphertext);
}
