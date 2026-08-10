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

The deep check (`GET /health/db`) and the versioned `/v1` contract arrive with their own
tickets. `GET /health` is deliberately shallow: on Workers each ping can land in a fresh
isolate, so a database round trip here would spend an Atlas connection per check. See
[ADR-0013](docs/adr/0013-operational-endpoints.md).

Errors use one envelope throughout:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

## Deployment

Deploys run only through GitHub Actions — `release` → staging, `main` → production. Never from
a dashboard, never from a local machine. `wrangler.toml` carries `env.staging` and
`env.production` sections and **no secrets**; secrets are set per environment with
`wrangler secret put --env <staging|production>`.

The workflows themselves are not in the repo yet — they arrive with their own ticket, and will
sit red until the Cloudflare credentials exist. That is deliberate: a red workflow is a visible
task where an absent one is a silent gap ([ADR-0015](docs/adr/0015-phase-zero-gate-split.md)).
