# ADR-0007 — Rollover runs every 15 minutes; FX fails on an incomplete set; a fourth job performs the hard erase

**Status:** accepted
**Supersedes:** Technical Spec §6 (three jobs → four; hourly rollover → 15-minute)
**Relates to:** workspace invariant 6

## Context

Three problems with the specified job design.

**Hourly rollover cannot serve non-hour timezone offsets.** Asia/Kolkata is +5:30,
Asia/Kathmandu +5:45, Pacific/Chatham +12:45. An hourly cron at :00 archives an Indian user
up to 30 minutes late and a Nepali user up to 45. India is squarely in this app's target
demographic. `streak:remind`'s "local evening window" has the same granularity problem.

**`fx:refresh` has no defined behaviour for a partial response.** §6.1 says pull "all 160
currencies" and "never silently fall back to hardcoded rates", but says nothing about a
provider returning 157. The prototype's `rate()` compounds this by falling back to `1.0` for
an unknown code — reporting a foreign amount as if it were USD.

**Nothing performs the hard erase.** Product Spec §3.7 and Technical Spec §12 both commit to
"30-day soft delete → hard erase" as an App Store 5.1.1(v) and PDPL requirement, and it is a
Phase 1 exit-gate item. But §6 specifies exactly three jobs — `fx:refresh`,
`month:rollover`, `streak:remind`. The erase never runs.

## Decision

**`month:rollover` runs every 15 minutes, not hourly.** Catch-up-safe selection makes extra
runs nearly free — a run with nothing eligible selects nothing and enqueues nothing — so
15-minute granularity bounds worst-case lateness to 15 minutes for every offset on earth.

**`streak:remind` runs hourly**, sending only to users whose local hour falls inside the
evening window, with a per-user per-day guard so exactly one reminder is sent regardless of
how many runs observe them.

**`fx:refresh` writes nothing on an incomplete set.** If any currency present in
`currencies.json` is missing from the provider response: write nothing, exit non-zero, alert.
A partial set means some user's display currency silently breaks, which is indistinguishable
from the fallback §6.1 already forbids. An unknown currency code at conversion time is an
error, never rate 1.0.

**Add a fourth job, `purge:deleted`, daily**, on the same cron→queue pattern: select users
with `deletedAt < now − 30d`, enqueue one message per user, and have the consumer delete that
user's documents across every collection, writing a minimal tombstone (hashed user id,
`purgedAt`) so PDPL erasure is *evidenced* rather than merely invisible. The email stays
**reserved** during the grace period — the recovery path needs it — and is released on purge.
`events` rows for a purged user are deleted, not anonymised, because the Phase 1 gate says
"no user data remains in any collection".

**The pinned rate set for an archive** is the `fx_rates` document for the last day of that
month in the user's timezone.

## Consequences

- Rollover cron fires 96×/day instead of 24×. Nearly all runs are no-ops that enqueue
  nothing, so the cost is negligible and the correctness gain covers a large share of the
  target market.
- FX failing loudly means a bad provider day blocks the rate update entirely rather than
  shipping a half-set. That is the intended trade: the previous set stays live and correct.
- The fourth job closes a compliance gap that would have failed both the Phase 1 exit gate
  and App Store review.
- Four cron triggers now exist where the spec described three; `wrangler.toml` and Technical
  Spec §6 both need the addition.
