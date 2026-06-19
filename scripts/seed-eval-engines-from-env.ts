/**
 * One-time migration: read legacy `EVAL_ENGINES` from the environment and PUT each
 * entry into the Walrus `eval_engines` catalog via the data gateway.
 *
 *   EVAL_ENGINES='{"price-range-guess":{"url":"http://localhost:5200"}}' \
 *   npm run seed-eval-engines-from-env
 */
import { fileURLToPath } from 'node:url';

import { GatewayClient, loadEvalEnginesFromEnv } from 'quadra-data';

try {
    const envPath =
        process.env.DATA_ENV_PATH ?? fileURLToPath(new URL('../.env', import.meta.url));
    process.loadEnvFile(envPath);
} catch {
    // env may already be provided by the parent process
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

async function main(): Promise<void> {
    const engines = loadEvalEnginesFromEnv();
    if (engines.size === 0) {
        console.error('EVAL_ENGINES is empty or unset; nothing to seed');
        process.exit(1);
    }

    const gatewayUrl = (process.env.DATA_GATEWAY_URL ?? 'http://localhost:8787').trim();
    const roleToken = required('ROLE_TOKEN_ADMIN');
    const client = new GatewayClient({ url: gatewayUrl, roleToken });

    console.log(`Seeding ${engines.size} eval engine(s) via ${gatewayUrl}...`);
    for (const [evaluatorId, engine] of engines) {
        const entry = await client.putEvalEngine({
            evaluator_id: evaluatorId,
            url: engine.url,
            ...(engine.enclaveId ? { enclave_id: engine.enclaveId } : {}),
        });
        console.log(`  ${evaluatorId} -> ${entry.url}`);
    }
    console.log('Done.');
}

main().catch((error) => {
    console.error('seed-eval-engines-from-env failed:', error);
    process.exit(1);
});
