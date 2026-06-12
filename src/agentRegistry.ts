import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { WalrusNetwork } from 'walrus-json';

/** One agent's on-chain identity (from `agent::AgentRegistry`). */
export interface AgentInfo {
    wallet: string;
    owner: string;
    category: string;
    name: string;
    description: string;
}

/** The `AgentInfo` Move struct fields as parsed by the JSON-RPC client. */
type RawAgentInfo = { owner: string; name: string; description: string; category: string };

export interface OnchainAgentsOptions {
    network: WalrusNetwork;
    url?: string;
    /** Shared `agent::AgentRegistry` object id. */
    registryId: string;
}

/**
 * Reads agent identity/registration from the on-chain `agent::AgentRegistry`
 * (a `Table<address, AgentInfo>`). Agents register on chain via
 * `agent::register_agent`; there is no Walrus mirror. Read-only.
 */
export class OnchainAgents {
    #client: SuiJsonRpcClient;
    #registryId: string;
    #tableId: string | undefined;

    constructor(options: OnchainAgentsOptions) {
        const url = options.url ?? getJsonRpcFullnodeUrl(options.network);
        this.#client = new SuiJsonRpcClient({ network: options.network, url });
        this.#registryId = options.registryId;
    }

    /** The `agents` Table object id (resolved once and cached). */
    async #table(): Promise<string> {
        if (this.#tableId) return this.#tableId;
        const res = await this.#client.getObject({
            id: this.#registryId,
            options: { showContent: true },
        });
        const fields = (res.data?.content as { fields?: Record<string, unknown> } | undefined)
            ?.fields;
        const table = fields?.agents as { fields?: { id?: { id?: string } } } | undefined;
        const id = table?.fields?.id?.id;
        if (!id) throw new Error(`AgentRegistry ${this.#registryId} has no agents table`);
        this.#tableId = id;
        return id;
    }

    /** One agent's info, or `undefined` if not registered. */
    async get(wallet: string): Promise<AgentInfo | undefined> {
        const tableId = await this.#table();
        let res;
        try {
            res = await this.#client.getDynamicFieldObject({
                parentId: tableId,
                name: { type: 'address', value: wallet },
            });
        } catch {
            return undefined; // not present
        }
        const info = (
            res.data?.content as { fields?: { value?: { fields?: RawAgentInfo } } } | undefined
        )?.fields?.value?.fields;
        if (!info) return undefined;
        return {
            wallet,
            owner: info.owner,
            category: info.category,
            name: info.name,
            description: info.description,
        };
    }

    async isRegistered(wallet: string): Promise<boolean> {
        return (await this.get(wallet)) !== undefined;
    }

    /** Every registered agent. Paginates the registry's dynamic fields. */
    async list(): Promise<AgentInfo[]> {
        const tableId = await this.#table();
        const out: AgentInfo[] = [];
        let cursor: string | null | undefined;
        for (;;) {
            const page = await this.#client.getDynamicFields({ parentId: tableId, cursor });
            const ids = page.data.map((f) => f.objectId);
            if (ids.length) {
                const objs = await this.#client.multiGetObjects({
                    ids,
                    options: { showContent: true },
                });
                for (const o of objs) {
                    const f = (
                        o.data?.content as
                            | {
                                  fields?: {
                                      name?: string;
                                      value?: { fields?: RawAgentInfo };
                                  };
                              }
                            | undefined
                    )?.fields;
                    const info = f?.value?.fields;
                    if (info && f?.name) {
                        out.push({
                            wallet: f.name,
                            owner: info.owner,
                            category: info.category,
                            name: info.name,
                            description: info.description,
                        });
                    }
                }
            }
            if (!page.hasNextPage) break;
            cursor = page.nextCursor;
        }
        return out;
    }
}
