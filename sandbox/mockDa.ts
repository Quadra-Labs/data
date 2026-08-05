/**
 * mockDa.ts — a stand-in for Flare's Data Availability layer.
 *
 * Lets the REAL ground-truth code path run unmodified offline: `fetchGroundTruth` →
 * `parseAnchorFeed` → `normalizeToPrice`, against the documented anchor-feeds-with-proof shape.
 *
 * It is faithful to the live API in the two places that matter, because a mock that is lenient
 * where the real endpoint is strict passes the sandbox and fails on Coston2:
 *
 *   - The voting round is a QUERY parameter. Sent in the body, the live API ignores it and answers
 *     with the latest round instead — which silently breaks replay.
 *   - The turnout field is spelled `turnoutBIPS`, not `turnoutBPS`. The Solidity struct uses the
 *     other spelling, and reading the wrong one zeroes a field the Merkle leaf covers.
 *
 * What this does NOT prove is Flare's live response schema. That was verified separately against
 * the real Coston2 endpoint — see DEPLOYMENT-STATE.md.
 */

import { createServer, type Server } from 'node:http';

export interface MockDaHandle {
    readonly baseUrl: string;
    /** The fixed price every feed resolves to, in 1e-8 fixed point. */
    readonly priceE8: bigint;
    /** What this mock will serve (or already served) for a round, in 1e-8 fixed point. */
    priceE8ForRound(votingRoundId: number): Promise<bigint>;
    stop(): Promise<void>;
}

export interface MockDaOptions {
    /** Raw feed value in `decimals`. Default 6050050 at 2 decimals = $60,500.50. */
    readonly value?: number;
    readonly decimals?: number;
    /** Default 0 — let the OS pick, so a stale run can never block a new one. */
    readonly port?: number;
    /**
     * Mirror a LIVE market price for this symbol instead of the fixed value.
     *
     * Needed whenever the agent under test builds its answer from real market data: a fixed
     * $60,500 "oracle" would score a perfectly good live band as a total miss.
     */
    readonly liveSymbol?: string;
}

export async function startMockDa(opts: MockDaOptions = {}): Promise<MockDaHandle> {
    const fallbackValue = opts.value ?? 6_050_050;
    const decimals = opts.decimals ?? 2;
    const port = opts.port ?? 0;

    // votingRoundId -> raw value. A finalized round never changes its answer, which is exactly
    // what makes a sandbox run replayable by the verify tool afterwards.
    const finalized = new Map<number, number>();

    async function liveSpot(symbol: string): Promise<number> {
        const res = await fetch(
            `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`,
        );
        const body = (await res.json()) as { data?: { amount?: string } };
        const usd = Number(body.data?.amount ?? '0');
        if (!Number.isFinite(usd) || usd <= 0) throw new Error(`mockDa: no live spot for ${symbol}`);
        return Math.round(usd * 10 ** decimals);
    }

    async function valueForRound(votingRoundId: number): Promise<number> {
        const cached = finalized.get(votingRoundId);
        if (cached !== undefined) return cached;
        const v = opts.liveSymbol
            ? await liveSpot(opts.liveSymbol).catch(() => fallbackValue)
            : fallbackValue;
        finalized.set(votingRoundId, v);
        return v;
    }

    const server: Server = createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(404).end();
            return;
        }
        let body = '';
        req.on('data', (chunk) => {
            body += String(chunk);
        });
        req.on('end', () => {
            let feedId = '0x00';
            try {
                const parsed = JSON.parse(body) as { feed_ids?: string[] };
                feedId = parsed.feed_ids?.[0] ?? feedId;
            } catch {
                // Fall through with the default; a malformed request still gets an answer shaped
                // like the real one.
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const votingRoundId = Number(url.searchParams.get('voting_round_id') ?? '1');
            void valueForRound(votingRoundId).then((value) => {
                const payload = [
                    {
                        body: { votingRoundId, id: feedId, value, turnoutBIPS: 9999, decimals },
                        proof: [],
                    },
                ];
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            });
        });
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;

    return {
        baseUrl: `http://127.0.0.1:${boundPort}`,
        priceE8: BigInt(fallbackValue) * 10n ** BigInt(8 - decimals),
        priceE8ForRound: async (votingRoundId: number) =>
            BigInt(await valueForRound(votingRoundId)) * 10n ** BigInt(8 - decimals),
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
