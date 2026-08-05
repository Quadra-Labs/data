/**
 * auth.ts — the one write this gateway still accepts.
 *
 * Everything else here is a read. The Sui version had three role tokens (`intake`, `scheduler`,
 * `admin`) authorizing engines to write scores, schedules and templates through HTTP; all of that
 * is gone, because on Flare each of those writers holds its own key and writes on chain, where the
 * contract checks it. Authorization is a contract check, not a shared secret.
 *
 * What survives is an agent publishing where it can be reached. That is genuinely off-chain — a
 * URL has no business on a ledger — and it is authenticated by the agent signing the request with
 * the same key its reputation is keyed by.
 *
 * The signature covers `${timestamp}.${rawBody}`, so both the body and the moment are bound. The
 * raw bytes are captured BEFORE parsing, because re-serializing parsed JSON produces different
 * bytes and the signature would never verify — that is the subtle part, and the Sui version had it
 * right.
 */

import { recoverMessageAddress, type Address, type Hex } from 'viem';

/** How far a request's timestamp may be from ours. */
export const AGENT_AUTH_WINDOW_MS = 60_000;

export type AuthFailure =
    | 'missing signature'
    | 'stale or missing timestamp'
    | 'bad signature'
    | 'unknown agent';

export interface AuthOk {
    readonly ok: true;
    readonly agent: Address;
}
export interface AuthFail {
    readonly ok: false;
    readonly reason: AuthFailure;
}
export type AuthResult = AuthOk | AuthFail;

export interface AuthHeaders {
    readonly ts: string | undefined;
    readonly sig: string | undefined;
}

export interface VerifyArgs {
    readonly headers: AuthHeaders;
    readonly rawBody: string;
    /**
     * Addresses allowed to publish. Without a registry contract there is nothing on chain that
     * says who is an agent, so the catalog is the allow-list — otherwise any key in the world
     * could claim any URL.
     */
    readonly allowed: ReadonlySet<string>;
    readonly windowMs?: number;
    readonly now?: number;
}

/**
 * Recover the signer and check it is allowed.
 *
 * The distinct failure reasons are deliberate: "stale timestamp" and "bad signature" send an agent
 * operator to completely different places, and collapsing them into one 401 is what makes this
 * kind of endpoint miserable to integrate against.
 */
export async function verifyAgentSignature(args: VerifyArgs): Promise<AuthResult> {
    const { ts, sig } = args.headers;
    if (!sig) return { ok: false, reason: 'missing signature' };

    const stamp = Number(ts);
    const now = args.now ?? Date.now();
    const window = args.windowMs ?? AGENT_AUTH_WINDOW_MS;
    if (!ts || !Number.isFinite(stamp) || Math.abs(now - stamp) > window) {
        return { ok: false, reason: 'stale or missing timestamp' };
    }

    let signer: Address;
    try {
        signer = await recoverMessageAddress({
            message: `${ts}.${args.rawBody}`,
            signature: sig as Hex,
        });
    } catch {
        return { ok: false, reason: 'bad signature' };
    }

    if (!args.allowed.has(signer.toLowerCase())) {
        return { ok: false, reason: 'unknown agent' };
    }
    return { ok: true, agent: signer };
}

/**
 * A URL an agent may publish.
 *
 * Only the scheme is checked. Anything more — reachability, TLS, a health probe — belongs at read
 * time, because a URL that resolves now can be dead by the time anyone follows it.
 */
export function isPublishableUrl(url: unknown): url is string {
    return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) && url.length <= 512;
}
