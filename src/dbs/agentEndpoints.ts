import type { WalrusJsonClient } from 'walrus-json';

import type { AgentEndpoint, AgentEndpointsDoc } from '../types.js';
import { PointerDoc } from './base.js';

/** Empty initial document, used by `bootstrap`. */
export const EMPTY_AGENT_ENDPOINTS: AgentEndpointsDoc = { endpoints: {}, updated_at: 0 };

/**
 * Where each live agent can be reached (Walrus, public). An agent self-publishes
 * its own public chat/ping URL (signed), so the web can route a chat to it and
 * check it is online before connecting. Not on-chain, so it survives an index rebuild.
 */
export class AgentEndpoints extends PointerDoc<AgentEndpointsDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** One agent's endpoint, or `undefined` if it has not published one. */
    async get(wallet: string): Promise<AgentEndpoint | undefined> {
        return (await this.read()).endpoints[wallet];
    }

    /** Publish (or refresh) an agent's public URL. */
    async set(wallet: string, url: string): Promise<AgentEndpoint> {
        const entry: AgentEndpoint = { wallet, url, updated_at: Date.now() };
        await this.update((doc) => {
            doc.endpoints[wallet] = entry;
            doc.updated_at = entry.updated_at;
            return doc;
        });
        return entry;
    }
}
