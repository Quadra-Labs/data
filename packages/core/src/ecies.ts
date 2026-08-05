/**
 * ecies.ts — the ONE place that decides which ECIES scheme a given payload uses.
 *
 * Two schemes are in play and they are not interchangeable:
 *
 *   geth-ECIES (ECIES_AES128_SHA256) — X9.63 KDF over SHA-256, AES-128-CTR, HMAC-SHA256, laid out
 *     as `65-byte ephemeral pubkey | 16-byte IV | ciphertext | 32-byte MAC`. This is what Flare
 *     Confidential Compute's TEE node decrypts with (its /decrypt endpoint is backed by
 *     go-ethereum's crypto/ecies), so EVERYTHING sealed to the TEE must use it.
 *
 *   eciesjs — HKDF-SHA256 + AES-256-GCM. Used only for the paying user's own wrap in a
 *     dual-reader envelope, which no TEE ever touches.
 *
 * Getting this wrong is not subtle, but it IS late: the blob lands on chain, the instruction
 * routes, and the enclave reports an opaque decrypt error with the money already escrowed. Hence
 * one module named after the choice, rather than an import in each call site.
 *
 * Caveat worth stating plainly: that the FCC node decrypts geth-ECIES is not verifiable against
 * Flare's published documentation. It follows from the node being go-ethereum-backed, and it will
 * only be confirmed the first time a real TEE opens one of these. If it turns out to be wrong,
 * this file is the only one that changes.
 */

import eciesGeth from 'ecies-geth';
import { encrypt as eciesJsEncrypt, decrypt as eciesJsDecrypt } from 'eciesjs';
import { toHex, type Hex } from 'viem';

import { strip, toBytes } from './hex.js';

/** Uncompressed secp256k1 public key bytes (0x04 | X | Y), which is what geth-ECIES expects. */
function publicKeyBytes(publicKeyHex: string): Buffer {
    const raw = toBytes(publicKeyHex);
    if (raw.length !== 65 || raw[0] !== 0x04) {
        throw new Error(
            `ecies: expected a 65-byte uncompressed public key (0x04...), got ${raw.length} bytes`,
        );
    }
    return raw;
}

/** Seal `plaintext` to a TEE public key using the scheme the FCC node can decrypt. */
export async function sealToTeeKey(teePublicKeyHex: string, plaintext: Uint8Array): Promise<Hex> {
    const sealed = await eciesGeth.encrypt(publicKeyBytes(teePublicKeyHex), Buffer.from(plaintext));
    return toHex(sealed);
}

/**
 * Open a geth-ECIES blob with a raw private key.
 *
 * Only useful OFF the FCC path — in production the TEE key lives inside the node and the
 * extension calls /decrypt rather than ever holding it. Kept for the locally simulated TEE and
 * for round-trip tests.
 */
export async function openTeeKey(privateKeyHex: string, ciphertext: Hex): Promise<Uint8Array> {
    const key = toBytes(privateKeyHex);
    return new Uint8Array(await eciesGeth.decrypt(key, toBytes(ciphertext)));
}

/** Seal to the paying user's key. Not TEE-facing, so it stays on eciesjs. */
export function sealToUserKey(userPublicKeyHex: string, plaintext: Uint8Array): Hex {
    return toHex(eciesJsEncrypt(strip(userPublicKeyHex), Buffer.from(plaintext)));
}

/**
 * Open a user-wrapped blob. Returns undefined rather than throwing when this key is not the one:
 * a caller trying its key against an envelope is asking a question, not reporting an error.
 */
export function openUserKey(privateKeyHex: string, ciphertext: Hex): Uint8Array | undefined {
    try {
        return new Uint8Array(eciesJsDecrypt(strip(privateKeyHex), toBytes(ciphertext)));
    } catch {
        return undefined;
    }
}
