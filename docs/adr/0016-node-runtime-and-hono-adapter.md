# ADR-0016 — The runtime is Node, with Hono kept as the HTTP layer

**Status:** accepted, 13 August 2026
**Supersedes:** `DEVELOPMENT_PLAN.md` §1.1 (the Cloudflare Workers substitution table), ADR-0015
(phase-zero gate split — it existed only because Cloudflare credentials were missing)
**Amends:** ADR-0008 (content is served from disk rather than from a Worker bundle), ADR-0010 (the
Workers rate-limiting binding becomes an app-level limiter)
**Relates to:** workspace Rule 1, invariant 9

## Context

The workspace CLAUDE.md fixes the backend as "TypeScript on Cloudflare Workers", and it was right to
challenge the Technical Spec's claim that the native MongoDB driver cannot run there — Cloudflare has
since shipped `node:net` and `node:tls`, and the driver does connect to Atlas under
`nodejs_compat_v2` with a compatibility date ≥ `2025-03-20`. That was verified under `wrangler dev`
before this decision, and `GET /health/db` returned `{"status":"ok","db":true}` against the real
cluster.

But *possible* had been doing the work of *appropriate*. Five costs became concrete once real work
started landing on the platform:

| Cost on Workers | On Node |
|---|---|
| `@cloudflare/vitest-pool-workers` **cannot load the `mongodb` driver** — verified 12 Aug 2026; the driver's `lib/bson.js` imports itself through workerd's path-based module registry. ADR-0014's per-run integration databases were blocked with no config-level fix | non-issue |
| `GET /v1/content/curriculum/pdf` — the client already links to a **server-generated PDF** (iOS ADR-0019), which is what the reader takes away offline. No practical PDF path on Workers | an ordinary library |
| WASM argon2id inside a CPU-limited isolate — unproven, and an unknown sitting directly on the login path | native `argon2`, measured at 23 ms hash / 21 ms verify |
| Ephemeral isolates against Atlas's connection ceiling — the **#1 risk** in `DEVELOPMENT_PLAN.md` §8, with a Durable Object connection broker as the documented escalation | one long-lived pool; the risk disappears rather than being mitigated |
| Cron handlers capped at 10 ms CPU, forcing a cron→queue fan-out for all four scheduled jobs | an ordinary scheduler; per-user fan-out kept only where it earns its place |

Two of these are worth separating from the rest. The vitest blocker is not a matter of taste: it
meant the month-rollover suite — the hard gate on every `main` merge that touches the most dangerous
job in the system — could not be written at all. And the connection ceiling was being *managed* on
Workers (`maxPoolSize: 1`, a broker in reserve) where on Node it simply is not a problem.

## Decision

**Run on Node 22 LTS. Keep Hono.**

Keeping Hono is the highest-leverage part. The route code, the error envelope, the middleware chain
and the tests are unchanged; what changed is the adapter (`@hono/node-server`) and the dependency
list. That made the runtime switch about half a day rather than a rewrite — and it keeps the door
open, because the same route code runs on both.

| Concern | Choice | Replaces |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript `strict` | workerd |
| HTTP | Hono on `@hono/node-server` | Hono on the Workers fetch handler |
| Password + answer hashing | native `argon2` | `hash-wasm` |
| Logging | pino, JSON to stdout | bespoke `console` JSON |
| Errors | `@sentry/node` | `@sentry/cloudflare` |
| Scheduling | in-process scheduler; per-user fan-out retained for `month:rollover` | Cron Triggers → Queues |
| Tests | vitest, plain Node environment | `@cloudflare/vitest-pool-workers` |
| Database | native `mongodb` driver ≥ 6.15.0 | unchanged |
| Validation | zod, types inferred | unchanged |
| JWT | `jose` | unchanged — WebCrypto works on Node, and churning it would buy nothing |

**Invariant 9 is served, not weakened.** Its mechanism was `maxPoolSize: 1, minPoolSize: 0`, and its
*end* was a hard bound on connections to Atlas with never one opened per operation. A single warm
pool with a configured ceiling (`MONGODB_MAX_POOL_SIZE`, default 10) serves that end strictly
better: connections are reused across requests instead of re-established per isolate. The escalation
path in the invariant — a Durable Object broker — is no longer needed and is not carried forward.

**Cloudflare is still the public face.** DNS, TLS, CDN, WAF and the cache rules invariant 8 depends
on all stay with Cloudflare; only the compute moves. `wrangler.toml`,
`worker-configuration.d.ts`, the `@cloudflare/*` dependencies and the vitest pool workaround are
deleted. Slice 0 ships a Dockerfile and a documented env contract, so which host runs the container
(§6 of `BACKEND_PLAN.md`) is a deploy decision rather than a code one.

## Consequences

- ADR-0014's per-run `hisaabwise_test_<runId>` database now actually works, so the rollover
  idempotency and skipped-run suites are writable.
- The curriculum PDF becomes an ordinary deliverable instead of an open platform question.
- The four scheduled jobs get a normal scheduler. `month:rollover` keeps its per-user fan-out anyway
  — that was never really about CPU limits, it is what gives per-user retries on the job that writes
  immutable history, and the unique `(userId, monthKey)` index makes those retries safe.
- Content moves from imported Worker modules to files read from disk at startup, validated with zod
  and count-asserted before the port is bound. ADR-0008's reasoning survives intact — static,
  versioned with the deploy, ETag'd, no database — only the mechanism changed.
- We lose Workers' zero-cold-start and its edge placement for compute. Both were bought with the
  five costs above, and neither is on the critical path for a monthly-budget app whose slowest
  operation is an argon2 verify.
