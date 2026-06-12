# Quadra Data Layer

Read / write / watch the Quadra databases over [Walrus](https://www.walrus.xyz/)
and [Seal](https://github.com/MystenLabs/seal). A reusable TypeScript library
plus a thin HTTP server.

Every public database is one JSON document on Walrus behind an on-chain
`JsonPointer` (via [`walrus-json`](../walrus-json)). Job results are private: each
is Seal-encrypted and stored as its own blob, readable only by the job's user and
agent — enforced on chain by `quadra::job_access::seal_approve`.

## Databases

| Database              | Storage            | Notes                                              |
| --------------------- | ------------------ | -------------------------------------------------- |
| `agent_scores`        | Walrus, public     | Equal-weight running average per agent wallet.     |
| `agents`              | Walrus, public     | Agent identity registry (`wallet, owner, category`).|
| `delayed_failed_jobs` | Walrus, public     | Append-only log of delayed/failed jobs.            |
| `job_templates`       | Walrus, public     | Exact lookup by template id.                       |
| `job_scheduler`       | Walrus, public     | `job_id -> expiry`; enumerate due jobs each epoch. |
| `job_results_index`   | Walrus, public     | `job_id -> blobId` of the sealed result.           |
| job results           | Seal, private      | One encrypted blob per job; user + agent only.     |

## Setup

```bash
npm install
cp .env.example .env      # set DATA_SECRET_KEY (+ DATA_NETWORK) only
npm run setup             # publishes both Move packages + creates the 6 pointers,
                          # then writes every other value back into .env
```

`npm run setup` signs everything with your `DATA_SECRET_KEY` (no separate `sui`
CLI account) — that address needs SUI (gas, for publishing) and WAL (storage, for
the pointers), and the `sui` CLI must be on PATH (used only to compile the Move
bytecode). It derives `WALRUS_JSON_PACKAGE_ID`, `QUADRA_PACKAGE_ID`,
`JOB_ACCESS_REGISTRY_ID`, and all `POINTER_*`, and fills `SEAL_KEY_SERVER_IDS`
with Mysten's allowlisted testnet key servers. On mainnet, supply those ids
yourself from the Seal verified key servers list.

Already have published packages? Use the lower-level `npm run bootstrap` instead,
which only creates the six pointers from an existing `WALRUS_JSON_PACKAGE_ID`.

## Library

```ts
import { DataLayer } from 'quadra-data';

const dl = DataLayer.fromEnv();

await dl.agents.register({ wallet, owner, category: 'finance' });
await dl.agentScores.recordJob(wallet, 87);          // folds into the running average
await dl.jobScheduler.set(jobId, Date.now() + 300_000);
const due = await dl.jobScheduler.due();             // for the scheduler engine

// Private results
await dl.jobResults.store(result);                   // encrypt + store + index
const result = await dl.jobResults.decrypt(jobId, userOrAgentKeypair);

// Watch
const w = dl.createWatcher();
w.on((change) => console.log(change.db, change.version));
w.start();
```

Decryption requires the **caller's own key** (the job's user or agent). The
server never decrypts — it only serves ciphertext.

## Services (two processes)

```bash
npm run serve     # REST writer  (port PORT=8787)
npm run watch     # gRPC watcher + SSE  (port WATCH_PORT=8788)
```

REST writer = the **write gateway** (`server.ts`): the sole holder of
`DATA_SECRET_KEY` and the only on-chain writer. `/agent-scores`, `/delayed-failed`,
`/templates`, `/scheduler`, `/job-results`, plus read-only `/agents`.

**Writes are role-gated.** Engines send a per-engine token (`x-quadra-role`,
configured via `ROLE_TOKEN_INTAKE` / `_SCHEDULER` / `_ADMIN`); agents send a
signed message (`x-quadra-ts` + `x-quadra-sig`). Reads are open. `admin` is a
superuser **except** for `job_results` (agent-signature only).

| Write | Allowed by |
| --- | --- |
| `POST /agent-scores/record`, `POST /delayed-failed` | scheduler, admin |
| `PUT /scheduler/:id` | intake, admin · `DELETE /scheduler/:id` | scheduler, admin |
| `PUT /templates` | admin |
| `POST /job-results` (sealed envelope) | agent signature (registered) only |

`GET /agents` / `/agents/:wallet` read the **on-chain** `agent::AgentRegistry`;
agents register on chain (`agent::register_agent`), not through the gateway.

Engines write through the gateway with `GatewayClient({ url, roleToken })` and
read with `DataLayer.forReads()` (an ephemeral key — they never hold the master
key). Only the gateway does Walrus writes, so engines stay watcher-friendly.
Test: `npm run test:gateway`.

Watch service (`watch-server.ts`): `GET /watch` streams `PointerUpdated` changes
as Server-Sent Events. It subscribes to the Sui **gRPC checkpoint stream**
(`SubscriptionService.subscribeCheckpoints`) — a true push stream — scans each
checkpoint for `pointer::PointerUpdated`, and on reconnect backfills missed
checkpoints via `getCheckpoint` (so no event is dropped). Override the endpoint
with `DATA_GRPC_URL`; tune reconnect with `WATCH_RECONNECT_MS`.

**Why two processes:** the long-lived gRPC stream cannot survive in a process that
also performs Walrus blob writes — the write storm starves the shared event
loop/connections and the stream never recovers. The watcher therefore runs on its
own (write-free) process, where the stream is rock-solid.

## Verify

```bash
npm run typecheck
npm run sandbox   # full round-trip incl. Seal allow/deny + watch (needs a live env)
```

The on-chain access policy is also unit-tested in
[`../contracts/tests/quadra_tests.move`](../contracts/tests/quadra_tests.move)
(`test_seal_access_user_and_agent`, `test_seal_access_third_party_denied`).
