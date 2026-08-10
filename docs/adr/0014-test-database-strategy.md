# ADR-0014 — Integration tests create a per-run database; they never touch the shared one

**Status:** accepted
**Relates to:** workspace Rule 4, `DEVELOPMENT_PLAN.md` §8, Phase 0 task 19

## Context

Rule 4 says dev and staging deliberately share one database and "never wipe it without
asking". But the phase gates need real collections to inspect and clear:

- Phase 0 must prove the native driver connects to Atlas from `wrangler dev` — the risk
  `DEVELOPMENT_PLAN.md` §8 calls the one genuinely new operational risk of the Workers move.
- Phase 4's rollover suite requires idempotency, skipped-run catch-up, and retry tests.
- Phase 1's gate requires proving a hard erase leaves **no** user data in **any** collection.

None of those are meaningful against a database that must not be cleared, and all of them are
destructive by nature.

## Decision

**Tests create a per-run database inside the same cluster.** `hisaabwise_test_<runId>`, from
the same `MONGODB_URI`, created at setup and dropped at teardown.

This exercises the genuine driver-to-Atlas path while making a destructive test structurally
incapable of touching `hisaabwise-dev`.

**Two guards, extending Phase 0 task 19:**

1. Refuse to run if the URI resolves to the production cluster.
2. Refuse to run if the target database name does not carry the `_test_` prefix.

**Domain-layer tests stay pure** — money, budget (both branches), security-answer
normalisation, numeric tolerance, streak day-key arithmetic. No database at all. These are the
ones that run on every save, and per `DEVELOPMENT_PLAN.md` §5 task 15 they are the
highest-value tests in the codebase.

## Consequences

- The shared dev/staging database can never be wiped by a test run, which removes the Rule 4
  hazard entirely rather than mitigating it with care.
- CI needs Atlas network access from GitHub Actions runners. Already planned — Technical Spec
  §8 sets network access to `0.0.0.0/0` because Workers has no static egress.
- A crashed run can leave an orphaned `hisaabwise_test_*` database behind. Mitigation: the
  name carries the run id, and a periodic sweep of stale test databases is cheap to add if it
  becomes noticeable.
- Integration tests are slower than mocked repositories. Accepted deliberately: mocking the
  driver would defeat the entire purpose of Phase 0 task 13, which exists to prove the driver
  works.
