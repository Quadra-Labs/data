/**
 * Register one evaluation engine in the Walrus `eval_engines` catalog via the
 * data gateway. Run after deploying an enclave and (optionally) on-chain registration.
 *
 *   EVALUATOR_ID=price-range-guess \
 *   ENCLAVE_URL=http://localhost:5200 \
 *   ENCLAVE_OBJECT_ID=0x... \
 *   npm run register-eval-engine
 *
 * Requires DATA_GATEWAY_URL (default http://localhost:8787) and ROLE_TOKEN_ADMIN.
 */
import { fileURLToPath } from 'node:url';

import { GatewayClient } from 'quadra-data';

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
    const evaluatorId = required('EVALUATOR_ID');
    const url = required('ENCLAVE_URL');
    const enclaveId = process.env.ENCLAVE_OBJECT_ID?.trim();
    const gatewayUrl = (process.env.DATA_GATEWAY_URL ?? 'http://localhost:8787').trim();
    const roleToken = required('ROLE_TOKEN_ADMIN');

    const client = new GatewayClient({ url: gatewayUrl, roleToken });
    const entry = await client.putEvalEngine({
        evaluator_id: evaluatorId,
        url,
        ...(enclaveId ? { enclave_id: enclaveId } : {}),
    });

    console.log(`Registered eval engine '${evaluatorId}' at ${entry.url}`);
    if (entry.enclave_id) console.log(`  enclave_id: ${entry.enclave_id}`);
}

main().catch((error) => {
    console.error('register-eval-engine failed:', error);
    process.exit(1);
});
