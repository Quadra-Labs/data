import type { WalrusJsonClient } from 'walrus-json';

import type { JobTemplate, JobTemplatesDoc } from '../types.js';
import { PointerDoc } from './base.js';

export const EMPTY_JOB_TEMPLATES: JobTemplatesDoc = { templates: {}, updated_at: 0 };

/**
 * Job templates (Walrus, public). Every job is well-defined; agents fetch the
 * template by id to know exactly what to return.
 */
export class JobTemplates extends PointerDoc<JobTemplatesDoc> {
    constructor(wj: WalrusJsonClient, pointerId: string, epochs: number) {
        super(wj, pointerId, epochs);
    }

    /** Exact lookup by template id. */
    async get(id: string): Promise<JobTemplate | undefined> {
        return (await this.read()).templates[id];
    }

    async list(): Promise<JobTemplate[]> {
        return Object.values((await this.read()).templates);
    }

    /** Create or replace a template. */
    async put(template: JobTemplate): Promise<JobTemplate> {
        await this.update((doc) => {
            doc.templates[template.id] = template;
            doc.updated_at = Date.now();
            return doc;
        });
        return template;
    }
}
