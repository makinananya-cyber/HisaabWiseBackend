# ADR-0015 — Phase 0's exit gate splits into a local half and a deploy half

**Status:** accepted
**Supersedes:** `DEVELOPMENT_PLAN.md` §5 Phase 0 exit gate
**Relates to:** workspace Rule 7, Rule 2

## Context

Phase 0's exit gate requires "the staging deploy succeeds and `GET /health` on the deployed
Worker returns `{status:"ok",db:true}`". But Rule 7 and `DEVELOPMENT_PLAN.md` §1 both state
that Cloudflare API credentials arrive later, and the Actions workflows need
`CLOUDFLARE_API_TOKEN` to deploy anything.

As written the gate cannot close, which means Phase 1 either waits on a dependency outside the
team's control, or the gate is quietly ignored — and a gate that gets ignored once stops being
a gate.

## Decision

**Split the gate in two, and let Phase 1 start on the local half.**

**Phase 0-local** — closes now, unblocks Phase 1. Everything provable under `wrangler dev` and
vitest:

- the native driver connecting to Atlas, and **WASM argon2 hashing and verifying, timed**
  (task 13 — the two platform risks, proven before anything is built on them)
- money, budget (both branches), security-answer, and numeric-tolerance domain suites
- content count assertions per [ADR-0008](0008-content-delivery.md)
- the cron→queue round trip via `curl "localhost:8787/__scheduled?cron=..."`
- every unimplemented route returning `501` against the contract in `docs/api.md`
- `GET /health` returning `{status:"ok"}` and `GET /health/db` returning `db:true` against
  `hisaabwise-dev`

**Phase 0-deploy** — stays open and owned. A hard prerequisite for the **first
`feature/mvp` → `release` PR**, not for starting Phase 1:

- both workflows running green
- health check on a deployed Worker
- branch protection on `release` and `main` requiring those checks
- a deliberately failing test on `release` demonstrably blocking the deploy

**Both workflows are written now**, with the deploy step present and referencing the secrets.
They will be red until the secrets exist — that is honest signal, not noise.

## Consequences

- Phase 1 proceeds on locally verifiable foundations instead of blocking on credentials.
- The deploy gate keeps its teeth: nothing reaches `release` or `main` until it is genuinely
  satisfied, which preserves Rule 2's branch model.
- The two platform risks (driver, argon2) are still proven **first**, before any feature rests
  on them. That was the substance of the original gate; only the deploy verification moves.
- Red workflows sit in the repo for a while. Accepted: an absent workflow is a silent gap,
  whereas a red one is a visible task.
