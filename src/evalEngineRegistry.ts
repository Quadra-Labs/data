import type { DataLayer, PointerWatcher } from './index.js';

/** Runtime shape engines use to reach and verify an evaluation enclave. */
export interface ResolvedEvalEngine {
    url: string;
    enclaveId?: string;
}

/** Minimal surface scheduler/competition engines need for routing. */
export interface EvalEngineLookup {
    get(evaluatorId: string): ResolvedEvalEngine | undefined;
    size(): number;
}

/**
 * Loads the Walrus-backed eval engine catalog and refreshes it when the
 * `eval_engines` pointer advances. Optionally overlays deprecated `EVAL_ENGINES`
 * env entries for local dev.
 */
export class EvalEngineRegistry implements EvalEngineLookup {
    #dl: DataLayer;
    #envOverlay: Map<string, ResolvedEvalEngine>;
    #engines = new Map<string, ResolvedEvalEngine>();
    #watcher: PointerWatcher | undefined;

    constructor(dl: DataLayer, options: { envOverlay?: Map<string, ResolvedEvalEngine> } = {}) {
        this.#dl = dl;
        this.#envOverlay = options.envOverlay ?? new Map();
        if (this.#envOverlay.size > 0) {
            console.warn(
                '[eval-registry] EVAL_ENGINES env overlay is deprecated; register engines via PUT /eval-engines/:id',
            );
        }
    }

    /** Load the catalog and start watching for pointer updates. */
    async start(): Promise<void> {
        await this.#refresh();
        this.#watcher = this.#dl.createWatcher();
        this.#watcher.on((c) => {
            if (c.db === 'eval_engines') void this.#refresh();
        });
        this.#watcher.start();
    }

    stop(): void {
        this.#watcher?.stop();
        this.#watcher = undefined;
    }

    get(evaluatorId: string): ResolvedEvalEngine | undefined {
        return this.#engines.get(evaluatorId);
    }

    size(): number {
        return this.#engines.size;
    }

    async #refresh(): Promise<void> {
        try {
            const entries = await this.#dl.evalEngines.list();
            const map = new Map<string, ResolvedEvalEngine>();
            for (const e of entries) {
                map.set(e.evaluator_id, {
                    url: e.url,
                    ...(e.enclave_id ? { enclaveId: e.enclave_id } : {}),
                });
            }
            for (const [id, eng] of this.#envOverlay) map.set(id, eng);
            this.#engines = map;
            console.log(`[eval-registry] loaded ${map.size} eval engine(s)`);
        } catch (error) {
            console.error(
                '[eval-registry] refresh failed:',
                error instanceof Error ? error.message : error,
            );
        }
    }
}

/** Parse deprecated `EVAL_ENGINES` env (`evaluator_id -> { url, enclave_id? }`). */
export function loadEvalEnginesFromEnv(): Map<string, ResolvedEvalEngine> {
    const raw = process.env.EVAL_ENGINES;
    if (!raw) return new Map();
    let parsed: Record<string, { url: string; enclave_id?: string }>;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `EVAL_ENGINES is not valid JSON: ${error instanceof Error ? error.message : error}`,
        );
    }
    return new Map(
        Object.entries(parsed).map(([id, e]) => [
            id,
            { url: e.url, ...(e.enclave_id ? { enclaveId: e.enclave_id } : {}) },
        ]),
    );
}

/** Build a registry with optional env overlay from `EVAL_ENGINES`. */
export function createEvalEngineRegistry(dl: DataLayer): EvalEngineRegistry {
    return new EvalEngineRegistry(dl, { envOverlay: loadEvalEnginesFromEnv() });
}
