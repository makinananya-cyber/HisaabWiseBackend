# HisaabWiseBackend

TypeScript backend for HisaabWise — **Node 22, Hono, MongoDB Atlas**.

Project rules, stack decisions, and the non-negotiable invariants live in the workspace `CLAUDE.md`
one directory up. Vocabulary is in [CONTEXT.md](CONTEXT.md); settled decisions are in
[docs/adr/](docs/adr/). The build plan is [docs/BACKEND_PLAN.md](docs/BACKEND_PLAN.md) and the schema
is [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

> **Runtime note.** This ran on Cloudflare Workers until 13 August 2026. It is now a long-lived Node
> process, for the reasons in [BACKEND_PLAN.md §3](docs/BACKEND_PLAN.md). Hono survived the move —
> the routes are unchanged — so the same code could return to Workers if that ever made sense.

## Getting started

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `MONGODB_URI`. It is the only variable required to boot, and it **must name a database in
its path** — a URI ending at `mongodb.net/` silently resolves to a database called `test`, so the
server refuses to start without one. Never point a local URI at production (Rule 4).

```bash
npm run dev
```

```bash
curl http://localhost:8080/health
```

→ `{"status":"ok"}`

**The startup order is the design, not an accident.** Configuration is validated, then the database
pool is connected, and only then is a port bound. A bad environment or an unreachable cluster is a
failure to boot rather than a process that accepts traffic it cannot serve.

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

`feature/mvp` has no CI by design, so running these before a PR is the substitute.

The HTTP seam is `app.request()` against an app built by `createApp` — real routing, real
middleware, real serialised responses, no socket. Tests supply their own configuration rather than
reading `.env`, so the suite behaves identically with or without local secrets.

## The contract corpus

The iOS app is already built, and its 37-fixture corpus is the definition of done for this backend:
each fixture is an exact payload a working client already decodes.

```bash
npm run contract:sync
```

Copies the corpus from a sibling `HisaabWiseIOS/` checkout into `test/contract/corpus/`, recording
the iOS commit it came from. Pass `-- --check` to fail instead of writing, which is how drift becomes
a build failure rather than a silent divergence.

`test/contract/endpoints.ts` lists every `/v1` endpoint with the slice that owns it. `npm test`
enforces three things about it: every `/v1` path the client calls is covered, every fixture is
claimed by an endpoint, and every endpoint marked `live` has a test behind it. Unimplemented
endpoints appear as `todo`, so the suite doubles as the progress report.

Shape checking asserts what the client actually depends on — key presence, JSON types, and the
`Money` invariants (integer `minor`, non-empty `display`, since iOS ADR-0003 deleted the client's
formatter). Figures are not asserted; a fixture's `553900` is one seeded user's data.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Shallow liveness. **No database access** — this is what the uptime monitor and the container health check hit. |
| `GET /health/db` | Deep check. Pings the database and returns `{"status":"ok","db":true}`. Never cached. |

Full shapes are in [docs/api.md](docs/api.md). The versioned `/v1` surface arrives slice by slice.

Errors use one envelope throughout:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

## Verifying the database connection

The driver is the native one, speaking the wire protocol to Atlas directly — no HTTP shim, no Data
API. With the server running:

```bash
npm run verify:db
```

→ `verify:db ok — {"status":"ok","db":true}`

The body is compared exactly, so a partially-true answer fails. Confirm the Atlas connection count
stays bounded while it runs — that is the external evidence for the pool ceiling, which no local
test can see.

### Observed platform facts

Recorded because they are the evidence rather than the claim:

| Fact | Measured |
| --- | --- |
| `argon2id` at m=19456 KiB / t=2 / p=1 | **23 ms hash, 21 ms verify** on Node. The CPU risk that existed against a Workers isolate does not exist here |
| `mongodb+srv://` SRV resolution | works — the Atlas connection string is usable as handed over, no seed-list form needed |
| Unreachable cluster | the process exits before binding a port, so nothing serves a request it cannot answer |

## Building and running in production

```bash
npm run build && npm start
```

esbuild bundles `src/server.ts` to `dist/server.js` with dependencies left external, so the native
`argon2` addon keeps working. `tsc` is the typecheck gate only and never emits, which means the gate
and the bundle cannot disagree about module resolution.

A [Dockerfile](Dockerfile) is provided and takes all configuration from the environment, so the
hosting target stays a late, reversible decision. **It has not been built yet** — there is no
container runtime on the machine it was written on; CI builds it on every push to `release` and
`main`.

## Deployment

Deploys run only through GitHub Actions — `release` → staging, `main` → production. Never from a
dashboard, never from a local machine. Secrets live in GitHub Environments and the host's own secret
store; nothing secret is committed.

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs lint, typecheck, tests, the contract-drift
check and the image build. **The deploy job is deliberately absent** until the hosting target is
chosen ([BACKEND_PLAN.md §6](docs/BACKEND_PLAN.md)) — the gates are host-independent and land now;
the deploy step lands with the decision.
