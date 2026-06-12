/**
 * Gateway RBAC checks: spawn the data gateway with role tokens and assert the
 * authorization layer (status codes) before any Walrus write. The final check is
 * one allowed write (slow — a real Walrus write) to prove the happy path.
 *
 * Run: npm run test:gateway   (needs .env configured)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 8799;
const TOKENS = { intake: 'tok-intake', scheduler: 'tok-scheduler', admin: 'tok-admin' };
const base = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean): void {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures++;
}

async function send(
    method: string,
    path: string,
    opts: { role?: string; sig?: boolean; body?: unknown } = {},
): Promise<number> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.role) headers['x-quadra-role'] = opts.role;
    if (opts.sig) {
        headers['x-quadra-ts'] = String(Date.now());
        headers['x-quadra-sig'] = 'AA=='; // deliberately invalid
    }
    const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return res.status;
}

async function waitHealth(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${base}/health`)).ok) return;
        } catch {
            /* not up yet */
        }
        await sleep(1000);
    }
    throw new Error('gateway did not become healthy');
}

async function main(): Promise<void> {
    console.log('\n═══ Gateway RBAC ═══\n');
    const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const serverPath = fileURLToPath(new URL('../src/server.ts', import.meta.url));
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(tsxBin, [serverPath], {
        cwd: dir,
        env: {
            ...process.env,
            PORT: String(PORT),
            ROLE_TOKEN_INTAKE: TOKENS.intake,
            ROLE_TOKEN_SCHEDULER: TOKENS.scheduler,
            ROLE_TOKEN_ADMIN: TOKENS.admin,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write(`    [gateway] ${d}`));

    try {
        await waitHealth(Date.now() + 30_000);

        console.log('authorization (no Walrus writes):');
        check('GET /agents open (no auth) -> 200', (await send('GET', '/agents')) === 200);
        check(
            'POST /agent-scores/record no token -> 401',
            (await send('POST', '/agent-scores/record', { body: { wallet: 'x', score: 1 } })) ===
                401,
        );
        check(
            '… wrong token -> 401',
            (await send('POST', '/agent-scores/record', {
                role: 'nope',
                body: { wallet: 'x', score: 1 },
            })) === 401,
        );
        check(
            'intake token on /agent-scores (scheduler-only) -> 403',
            (await send('POST', '/agent-scores/record', {
                role: TOKENS.intake,
                body: { wallet: 'x', score: 1 },
            })) === 403,
        );
        check(
            'intake token on PUT /templates (admin-only) -> 403',
            (await send('PUT', '/templates', { role: TOKENS.intake, body: {} })) === 403,
        );
        check(
            'intake token on DELETE /scheduler (scheduler-only) -> 403',
            (await send('DELETE', '/scheduler/x', { role: TOKENS.intake })) === 403,
        );
        check(
            'scheduler token on PUT /scheduler (intake-only) -> 403',
            (await send('PUT', '/scheduler/x', {
                role: TOKENS.scheduler,
                body: { expires_at: 1 },
            })) === 403,
        );
        check(
            'POST /job-results no signature -> 401',
            (await send('POST', '/job-results', { body: {} })) === 401,
        );
        check(
            'admin token on /job-results (agent-signature only) -> 401',
            (await send('POST', '/job-results', { role: TOKENS.admin, body: {} })) === 401,
        );

        console.log('\nallowed write (real Walrus write, slow):');
        const wallet = `0x${'c'.repeat(64)}`;
        const status = await send('POST', '/agent-scores/record', {
            role: TOKENS.scheduler,
            body: { wallet, score: 75 },
        });
        check('scheduler token records a score -> 200', status === 200);
    } finally {
        child.kill();
    }

    if (failures > 0) {
        console.error(`\n✗ ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\n✓ ALL CHECKS PASSED\n');
    process.exit(0);
}

main().catch((error) => {
    console.error('\n✗ gateway-auth failed:', error);
    process.exit(1);
});
