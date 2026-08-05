/**
 * dotenv.ts — a tiny, dependency-free .env loader.
 *
 * Node does not auto-load `.env` for a plain `node dist/...`, so a value the operator wrote there
 * would simply be ignored. This loads the given files into `process.env` WITHOUT overriding values
 * already present, which is the important half: a secret injected by pm2, Docker or the shell must
 * beat a stale `.env` sitting on disk.
 *
 * That precedence is the opposite of Node's own `process.loadEnvFile`, which the Sui version used
 * in six places — it overrides exported variables, so a correct deployment could be silently
 * downgraded by a forgotten file.
 */

import { existsSync, readFileSync } from 'node:fs';

export function loadDotEnv(paths: readonly string[]): void {
    for (const path of paths) {
        if (!existsSync(path)) continue;
        let text: string;
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            continue;
        }
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (line.length === 0 || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            const existing = process.env[key];
            if (existing === undefined || existing.length === 0) process.env[key] = value;
        }
    }
}
