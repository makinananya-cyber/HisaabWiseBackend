# ADR-0013 — `/health` does no database work; export streams JSON with CSV served per part

**Status:** accepted
**Supersedes:** Technical Spec §5 (`GET /health` shape, `GET /v1/me/export` shape)
**Relates to:** workspace invariant 9, Technical Spec §12 (PDPL portability)

## Context

**`/health` returning `db:true` costs a database round trip on every ping.** Technical Spec §5
specifies `{status:"ok", db:true}` and §8 puts an uptime monitor on it at minute granularity.
On Workers each ping can land in a fresh isolate, so a naive implementation opens an Atlas
connection per check purely to prove Atlas is reachable — spending exactly the resource
invariant 9 says to conserve.

**`GET /v1/me/export` must produce "JSON + CSV of everything" from inside a Worker.** For a
user with a year of archives carrying full entry payloads that is multiple megabytes assembled
across many reads, inside one request's CPU and subrequest budget. And "JSON **and** CSV" does
not describe a single HTTP response.

## Decision

**Split the health endpoint.** `GET /health` returns `{status:"ok"}` with no database access —
this is what the uptime monitor and the Cloudflare health check hit. `GET /health/db` performs
the real ping and returns `{status:"ok", db:true}` — this is what the Phase 0 exit gate,
post-deploy verification, and a lower-frequency deep check use.

**Stream JSON as the canonical export; serve CSV per part.** `GET /v1/me/export` returns a
streamed JSON document built from cursors rather than materialised in memory, so size scales
without hitting the memory ceiling. CSV becomes
`GET /v1/me/export?format=csv&part=expenses|archives|learn|events` — one flat table per part,
which is what CSV can honestly represent (a single CSV of "everything" would misrepresent the
shape of the data).

## Considered and rejected

- **Caching the `/health` database ping at module scope for ~30 seconds.** Keeps one endpoint,
  but makes `db:true` mean "was true recently" — on a field whose entire purpose is
  truthfulness.
- **A queued export job that emails a link.** Correct at scale, disproportionate at launch for
  a feature exercised rarely. If exports later time out for the heaviest users, that is the
  point to move — and the cron→queue pattern will already be proven.

## Consequences

- The uptime monitor stops consuming Atlas connections, which matters most precisely when the
  service is under stress.
- Two small deviations from the Technical Spec §5 contract; `docs/api.md` records both.
- The PDPL portability requirement in Technical Spec §12 is satisfied without new
  infrastructure.
- Streaming means an export cannot report a total size up front and cannot be retried
  mid-stream. Acceptable for a rarely-used compliance endpoint.
