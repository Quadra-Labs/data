# quadra-data

The read layer, the deterministic core, and the verifier.

Three packages live here:

| Package | What it is |
| --- | --- |
| **`quadra-core`** (`packages/core`) | Pure, deterministic code — the scorer, the EIP-712 settlement format, the audit receipt, the dual-reader envelope. No chain access, no secrets, no native dependencies. Every other repo depends on it. |
| **`quadra-verify`** (`packages/verify`) | A command that re-derives a settlement from chain data alone. |
| **`quadra-data`** (this root) | An off-chain index of the Flare markets, plus the HTTP surface that serves it. |

## Why an index exists

A chain is an append-only log, not a database. Coston2's public RPC offers one storage read at a
time, or a log scan **capped at 30 blocks per request**. Measured on 2026-08-05:

| | |
| --- | --- |
| block time | 1.69 s |
| blocks per day | 51,064 |
| `eth_getLogs` requests to scan 30 days | **51,064** |

A 50-agent leaderboard is 150 separate contract reads. "Jobs this buyer paid for last month" is the
scan above, which the endpoint throttles long before it finishes. So the index does that walk once,
in the background, and answers from disk after.

**Nothing in it is authoritative.** Delete the file and it rebuilds from the chain. Every value is
re-readable from a contract. And `quadra-verify` never consults it — it reads calldata and contract
storage only, because a verifier that trusted our server would not be a verifier. See
`_migration/KNOWN-CONSTRAINTS.md` entry 3.

## Running it

```bash
pnpm install
pnpm serve            # gateway + indexer in one process, on :8787
```

No configuration is required. Addresses come from `contracts/deployments/<chainId>.json`, and the
indexer finds its own start block by binary search over `eth_getCode`. Copy `.env.example` to
`.env` only to override something.

```bash
pnpm indexer          # the indexer alone, for a split deployment
pnpm sandbox          # the narrated end-to-end run
pnpm print-addresses  # what this deployment points at, and whether it holds code
pnpm typecheck
```

Splitting the two processes means sharing `INDEXER_DB_PATH` **on one host** — SQLite WAL is one
writer and many readers, on one filesystem. The Sui deployment split them because a long-lived gRPC
stream could not survive alongside Walrus writes; neither of those exists now, so one process is
the default.

## The HTTP surface

Every read has two paths — the index when it is current, the chain when it is not — so the gateway
works before the indexer has ever run.

| | |
| --- | --- |
| `GET /health` | Always 200 while the process answers. Reports `ok` / `warming` / `degraded`, the cursor lag, and any warnings. |
| `GET /ready` | 503 until the index is current. Liveness and readiness are separate on purpose. |
| `GET /agents`, `/agents/query`, `/agents/:wallet` | Identity from the catalog, everything scored from the chain. |
| `GET /agents/:wallet/jobs`, `/users/:user/jobs` | Job history either side of a trade. |
| `GET /passport/:agent/:evaluatorId` | Straight from the contract, always. |
| `GET /jobs/:jobId`, `/jobs/recent`, `/jobs/due` | `/jobs/due` is what lets a keeper stop guessing with a lookback scan. |
| `GET /jobs/:jobId/ciphertext` | The delivered result, recovered from `deliver` calldata. A convenience — `quadra-verify` recovers it itself. |
| `GET /competitions`, `/competitions/:id` | |
| `GET /stats/activity`, `/delayed-failed` | |
| `GET /ground-truth?feed&round` | A cached mirror of Flare's DA layer, **for display only**. |
| `GET /watch` | Server-sent events for everything the indexer applies. |
| `POST /agent-endpoints` | The one write. Signed by the agent's own key. |

Money is returned as **decimal strings**, not numbers. QUADRA has 18 decimals; a client parsing
`"1000000000000000000"` into a JS number would silently round it.

### Why there is only one write

The Sui gateway held the only key and accepted scores, schedules and templates over HTTP behind
three role tokens. None of that survives. On Flare each writer holds its own key and writes on
chain, where the contract checks it — authorization is a contract check, not a shared secret. What
remains is an agent publishing a URL, which genuinely has no business on a ledger.

## The verifier

```bash
pnpm --filter quadra-verify exec quadra-verify job 0xabc… --tx 0xdef…
```

Given a job or competition id it re-derives the settlement: the published receipt hashes to the
anchored hash, the signature recovers to the registered TEE, the receipt names the registered
image, the sealed commitments match what was locked in before the answer was known, the ground
truth re-fetched from Flare's DA layer agrees, and replaying the scorer reproduces every score.

Checks report `PASS`, `FAIL` or `SKIP`. Skipped is a real state, not a quiet pass — a paid job's
score can only be replayed by the buyer, because the result stays private forever.

`--tx` is a search hint. It bounds the log scan to the settle block, which is the difference
between a few requests and a few thousand. Every check still re-derives independently.

## The sandbox

```bash
pnpm sandbox              # all five steps
pnpm sandbox -- verify    # one of them
```

1. **index** — the read layer against live Coston2
2. **envelope** — a forecast sealed so the buyer and the TEE can read it and the operator cannot
3. **oracle** — the real ground-truth path against a mock DA layer, offline
4. **watch** — the push feed
5. **verify** — a full settlement replay, then the same settlement forged, then one score altered

Steps 2 to 5 need no chain and no keys.

## What changed from the Sui version

The storage half is gone. Seven mutable JSON documents on Walrus behind Sui pointers, Seal-encrypted
results, a write-behind queue and a privileged writer all disappear, because on Flare the chain
holds what they held:

| | Sui | Flare |
| --- | --- | --- |
| Reputation | a Walrus JSON file | `Passport.sol` |
| Job results | a Seal-encrypted blob | `deliver` calldata, dual-reader ECIES |
| Result access | a contract check plus key servers | arithmetic — only two wraps exist |
| Who may write scores | the gateway's key, behind a role token | a TEE signature the contract verifies |
| Templates | an admin-editable document | compiled into `quadra-core` |

The read half survived, and matters more here than it did there.
