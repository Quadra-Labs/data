/**
 * boot.ts — import-once side effects, before any config read or RPC call.
 *
 * Import this FIRST from every executable in this package. The Sui version had the opposite
 * arrangement: three sandbox scripts each set up their own network policy while the actual server
 * and indexer set up none, so the processes being validated behaved differently from the ones
 * doing the validating.
 *
 * Two things happen here:
 *
 *   1. `.env` is loaded from the current directory, the repo root, and the workspace parent. The
 *      parent entry matters because the Quadra repos are sibling checkouts sharing one `.env`.
 *   2. DNS resolves IPv4-first. `localhost` resolving to `::1` on a host with no IPv6 listener is
 *      a connection refused that looks like a dead service, and it costs nothing for remote HTTPS.
 */

import { setDefaultResultOrder } from 'node:dns';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotEnv } from './config/dotenv.js';

loadDotEnv([
    join(process.cwd(), '.env'),
    // src/{,dist} -> the repo root
    fileURLToPath(new URL('../.env', import.meta.url)),
    // The parent of the sibling checkouts, where a single .env can serve every Quadra repo.
    fileURLToPath(new URL('../../.env', import.meta.url)),
    join(homedir(), '.quadra', '.env'),
]);

try {
    setDefaultResultOrder('ipv4first');
} catch {
    // Older Node without this API: ignore. The failure it prevents is a nuisance, not a hazard.
}
