import type { JsonValue, WalrusJsonClient } from 'walrus-json';

import { withWriteLock } from '../writeLock.js';

/**
 * A typed wrapper around one pointer-backed JSON document.
 *
 * Reads resolve the pointer to its current blob; writes read the current value,
 * apply a pure mutator in memory, then write a brand-new blob and re-point the
 * `JsonPointer` to it in a single `commit`. The whole-document replace keeps the
 * data fully typed in TypeScript instead of threading dot-paths.
 */
export class PointerDoc<T> {
    constructor(
        protected readonly wj: WalrusJsonClient,
        readonly pointerId: string,
        protected readonly epochs: number,
    ) {}

    /** The current value of the document. */
    async read(): Promise<T> {
        return (await this.wj.resolvePointer(this.pointerId)) as unknown as T;
    }

    /**
     * Read, apply `mutator` to a clone, then persist the result as a new blob and
     * re-point. Returns the persisted value. Serialized per client (the wallet has
     * one transaction in flight at a time): overlapping writes — same pointer or
     * not — would spend the same pointer version or gas/WAL coins and equivocate.
     */
    update(mutator: (current: T) => T): Promise<T> {
        return withWriteLock(this.wj, () => this.#commit(mutator));
    }

    async #commit(mutator: (current: T) => T): Promise<T> {
        const doc = await this.wj.openPointer(this.pointerId);
        const current = doc.toJSON() as unknown as T;
        const next = mutator(structuredClone(current));
        doc.replace(next as unknown as JsonValue);
        await doc.commit({ epochs: this.epochs });
        return next;
    }
}
