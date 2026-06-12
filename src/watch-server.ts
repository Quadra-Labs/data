/**
 * Watch service: subscribes to the Sui gRPC checkpoint stream and pushes
 * `PointerUpdated` changes to clients over Server-Sent-Events (`GET /watch`).
 *
 * This runs as its OWN process, separate from the REST writer (`server.ts`): the
 * long-lived gRPC stream cannot survive in a process that also performs Walrus
 * blob writes (the write storm starves the event loop / connections and the
 * stream never recovers). This process never writes, so the stream stays healthy.
 */
import Fastify, { type FastifyReply } from 'fastify';

import { DataLayer } from './index.js';
import type { PointerChange } from './watch.js';

function startWatchServer(): void {
    try {
        process.loadEnvFile('.env');
    } catch {
        // No .env file — rely on the ambient environment.
    }

    const dl = DataLayer.fromEnv();
    const app = Fastify({ logger: true });
    const watcher = dl.createWatcher();
    watcher.start();

    app.get('/health', async () => ({ ok: true, network: dl.config.network }));

    app.get('/watch', (req, reply: FastifyReply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        reply.raw.write(`event: ready\ndata: {}\n\n`);
        const send = (change: PointerChange) => {
            reply.raw.write(`data: ${JSON.stringify(change)}\n\n`);
        };
        const off = watcher.on(send);
        req.raw.on('close', off);
    });

    app.listen({ port: dl.config.watchPort, host: '0.0.0.0' })
        .then((address) => app.log.info(`Quadra watch service listening on ${address}`))
        .catch((error) => {
            app.log.error(error);
            process.exit(1);
        });
}

startWatchServer();
