import type { WalrusJsonClient } from 'walrus-json';

import type { EvalEngineEntry, EvalEnginesDoc } from '../types.js';
import { PointerDoc } from './base.js';

export const EMPTY_EVAL_ENGINES: EvalEnginesDoc = { engines: {}, updated_at: 0 };

/**
 * Evaluation engine routing catalog (Walrus, public). Maps each template's
 * `evaluator_id` to the enclave HTTP endpoint (and optional on-chain enclave id).
 */
export class EvalEngines extends PointerDoc<EvalEnginesDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** Exact lookup by evaluator id. */
    async get(evaluatorId: string): Promise<EvalEngineEntry | undefined> {
        return (await this.read()).engines[evaluatorId];
    }

    async list(): Promise<EvalEngineEntry[]> {
        return Object.values((await this.read()).engines);
    }

    /** Create or replace an eval engine entry. */
    async put(entry: Omit<EvalEngineEntry, 'updated_at'>): Promise<EvalEngineEntry> {
        const stored: EvalEngineEntry = { ...entry, updated_at: Date.now() };
        await this.update((doc) => {
            doc.engines[entry.evaluator_id] = stored;
            doc.updated_at = Date.now();
            return doc;
        });
        return stored;
    }

    /** Remove an eval engine entry. */
    async remove(evaluatorId: string): Promise<boolean> {
        let removed = false;
        await this.update((doc) => {
            if (!(evaluatorId in doc.engines)) return doc;
            delete doc.engines[evaluatorId];
            doc.updated_at = Date.now();
            removed = true;
            return doc;
        });
        return removed;
    }
}
