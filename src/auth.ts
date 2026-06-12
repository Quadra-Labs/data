import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

import type { DataLayer } from './index.js';
import type { GatewayAuth, Role } from './config.js';

/** Resolve the role for the request's `x-quadra-role` token, if any. */
function roleOf(auth: GatewayAuth, req: FastifyRequest): Role | undefined {
    const token = req.headers['x-quadra-role'];
    return typeof token === 'string' ? auth.roleTokens.get(token) : undefined;
}

/** Guard a write route to the given roles (admin is always allowed). */
export function requireRole(auth: GatewayAuth, ...roles: Role[]): preHandlerHookHandler {
    return async (req, reply) => {
        const role = roleOf(auth, req);
        if (!role) return reply.code(401).send({ error: 'missing or invalid role token' });
        if (role !== 'admin' && !roles.includes(role)) {
            return reply.code(403).send({ error: `role '${role}' not allowed here` });
        }
    };
}

/** Verify the agent-signed message and attach the recovered wallet. */
async function verifyAgentSignature(
    req: FastifyRequest,
    reply: FastifyReply,
    windowMs: number,
): Promise<string | undefined> {
    const ts = Number(req.headers['x-quadra-ts']);
    const sig = req.headers['x-quadra-sig'];
    const rawBody = (req as { rawBody?: string }).rawBody ?? '';
    if (typeof sig !== 'string') {
        reply.code(401).send({ error: 'missing signature' });
        return undefined;
    }
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > windowMs) {
        reply.code(401).send({ error: 'stale or missing timestamp' });
        return undefined;
    }
    try {
        const message = new TextEncoder().encode(`${ts}.${rawBody}`);
        const publicKey = await verifyPersonalMessageSignature(message, sig);
        return publicKey.toSuiAddress();
    } catch {
        reply.code(401).send({ error: 'bad signature' });
        return undefined;
    }
}

/**
 * Guard an agent-facing write: the request must carry a valid agent signature
 * (with `requireRegistered`, the signer must also exist in the on-chain
 * `AgentRegistry`). When `allowAdmin` is true, an admin role token bypasses.
 * Attaches `req.agentWallet`.
 */
export function requireAgent(
    dl: DataLayer,
    auth: GatewayAuth,
    options: { requireRegistered: boolean; allowAdmin?: boolean },
): preHandlerHookHandler {
    return async (req, reply) => {
        if (options.allowAdmin !== false && roleOf(auth, req) === 'admin') return;
        const wallet = await verifyAgentSignature(req, reply, auth.agentAuthWindowMs);
        if (!wallet) return; // reply already sent
        if (options.requireRegistered && !(await dl.agents.isRegistered(wallet))) {
            return reply.code(401).send({ error: 'agent not registered' });
        }
        (req as { agentWallet?: string }).agentWallet = wallet;
    };
}
