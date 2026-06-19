/**
 * Unit tests for the eval_engines Walrus document helpers.
 * Run: npm run test:eval-engines
 *
 * Requires a live env (POINTER_EVAL_ENGINES + DATA_SECRET_KEY) — same as sandbox.
 */
import { fileURLToPath } from 'node:url';

import { DataLayer } from '../src/index.js';

try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
    // rely on ambient env
}

let failures = 0;
function check(label: string, ok: boolean): void {
    if (!ok) {
        failures++;
        console.error(`✗ ${label}`);
    } else {
        console.log(`✓ ${label}`);
    }
}

async function main(): Promise<void> {
    const dl = DataLayer.fromEnv();
    const id = `test-eval-${Date.now()}`;
    const url = 'http://localhost:5999';

    await dl.evalEngines.put({ evaluator_id: id, url });
    const got = await dl.evalEngines.get(id);
    check('put + get round-trips url', got?.url === url && got.evaluator_id === id);

    const listed = await dl.evalEngines.list();
    check('list includes new entry', listed.some((e) => e.evaluator_id === id));

    const removed = await dl.evalEngines.remove(id);
    check('remove returns true', removed);
    check('get after remove is undefined', (await dl.evalEngines.get(id)) === undefined);

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
