/**
 * Sandbox helper: a write-free watcher process. Subscribes to the gRPC checkpoint
 * stream, prints READY once subscribed, then prints WATCH_OK:<blob>:cp<n> on the
 * first job_scheduler change and exits. Used by integration.ts step 3 to prove the
 * separate-process watcher catches a write made by another process.
 */
import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

import { DataLayer } from '../src/index.js';

process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));

const dl = DataLayer.fromEnv();
const from = process.env.WATCH_FROM;
const watcher = dl.createWatcher(from ? { fromCheckpoint: Number(from) } : {});
watcher.on((c) => {
    if (c.db === 'job_scheduler') {
        console.log(`WATCH_OK:${c.blobId}:cp${c.checkpoint}`);
        watcher.stop();
        process.exit(0);
    }
});
watcher.start();

// The watcher seeds + subscribes asynchronously; signal readiness shortly after.
setTimeout(() => console.log('READY'), 3000);
setTimeout(() => {
    console.error('WATCH_TIMEOUT');
    watcher.stop();
    process.exit(1);
}, 120_000);
