# HisaabWiseBackend

TypeScript backend for HisaabWise, on Cloudflare Workers with Hono and MongoDB Atlas.

Project rules, stack decisions, and the non-negotiable invariants live in the workspace
`CLAUDE.md` one directory up. Vocabulary is in [CONTEXT.md](CONTEXT.md); settled decisions are
in [docs/adr/](docs/adr/).

## Getting started

```bash
npm install
```

```bash
npm run dev
```

Then:

```bash
curl http://localhost:8787/health
```

→ `{"status":"ok"}`

`npm install` also runs `wrangler types`, which generates `worker-configuration.d.ts` — the
Workers runtime types and the global `Env` derived from `wrangler.toml`. It is gitignored and
regenerated rather than committed, so it can never be stale relative to the config it
describes. Re-run `npm run cf-typegen` after editing `wrangler.toml`.

For anything needing secrets, copy [.dev.vars.example](.dev.vars.example) to `.dev.vars` and
fill it in. `.dev.vars` is gitignored and must stay that way — and a local `MONGODB_URI` never
points at the production database.

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`, against the real Worker built
from `wrangler.toml`.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Shallow liveness. **No database access** — this is what the uptime monitor hits. |
| `GET /health/db` | Deep check. Pings the database and returns `{"status":"ok","db":true}`. Never cached. |

`GET /health` is deliberately shallow: on Workers each ping can land in a fresh isolate, so a
database round trip here would spend an Atlas connection per check. `GET /health/db` is the one
that answers for the database, and exists to be truthful *now* — it is never cached and its
result is never memoised, so it is for the deploy gate and a low-frequency deep check, not for a
minute-granularity monitor. See [ADR-0013](docs/adr/0013-operational-endpoints.md).

Full shapes, including the `503` codes on `/health/db`, are in [docs/api.md](docs/api.md). The
versioned `/v1` contract arrives with its own ticket.

Errors use one envelope throughout:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

## Verifying the database connection

The MongoDB driver used here is the native one, speaking the wire protocol to Atlas directly —
no HTTP shim and no Data API. That is the platform bet the whole runtime choice rests on, so it
is verified by running it rather than by assertion. With `.dev.vars` pointing at the dev
database and `npm run dev` running:

```bash
npm run verify:db
```

→ `verify:db ok — {"status":"ok","db":true}`

### What has been observed so far

Recorded because it is the evidence, not the claim, and re-deriving it costs a working
connection string. Under `wrangler dev` on `workerd@1.20260801.1`, `nodejs_compat_v2`,
compatibility date `2025-03-20`, `mongodb@6.21.0`:

| Given `MONGODB_URI` | Result | What it proves |
| --- | --- | --- |
| absent | `503 DB_NOT_CONFIGURED` | the fail-fast path, in the real runtime |
| `mongodb://127.0.0.1:27017/…` (nothing listening) | `503 DB_UNAVAILABLE`, logged as `MongoServerSelectionError: proxy request failed, cannot connect to the specified address` | the driver loads on workerd and opens a real TCP connection through `node:net` — no shim, no Data API |
| `mongodb+srv://…@cluster0.doesnotexist.mongodb.net/…` | logged as `Error: querySrv ENOTFOUND _mongodb._tcp.cluster0.doesnotexist.mongodb.net` | DNS SRV resolution genuinely runs, so the `mongodb+srv://` URI Atlas hands you works as-is rather than needing the seed-list form |

**Still unproven:** a successful round trip — TLS handshake, SCRAM authentication, and the `ping`
itself — which needs the dev cluster's connection string. `npm run verify:db` is that check.
Confirm the connection count in the Atlas metrics view stays at one while it runs; that is the
external evidence for the pool cap, which no local test can see.

The test suite cannot make the live assertion itself. `@cloudflare/vitest-pool-workers` serves
dependencies to workerd file by file instead of bundling them, and on that path the driver's
`lib/bson.js` ends up importing itself — the reason is written out in
[vitest.config.ts](vitest.config.ts). `wrangler dev` and `wrangler deploy` bundle with esbuild
and are unaffected. The suite therefore pins `MONGODB_URI` empty and covers the misconfiguration
path and the absence of database work on `GET /health`; the live round trip is the command above.

This blocks the per-run integration databases in
[ADR-0014](docs/adr/0014-test-database-strategy.md), so it has to be resolved before the
repository layer lands.

## Deployment

Deploys run only through GitHub Actions — `release` → staging, `main` → production. Never from
a dashboard, never from a local machine. `wrangler.toml` carries `env.staging` and
`env.production` sections and **no secrets**; secrets are set per environment with
`wrangler secret put --env <staging|production>`.

The workflows themselves are not in the repo yet — they arrive with their own ticket, and will
sit red until the Cloudflare credentials exist. That is deliberate: a red workflow is a visible
task where an absent one is a silent gap ([ADR-0015](docs/adr/0015-phase-zero-gate-split.md)).
