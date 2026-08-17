# ADR-0006 — The server derives `monthKey`; the live month only moves forward; closed months reject writes

**Status:** accepted
**Supersedes:** Technical Spec §4 (archive entries store `entryDate`, not day-of-month)
**Relates to:** workspace invariants 6 and 7, defect D6

## Context

Two features were specified separately and collide.

**Offline queue × rollover.** A user logs an expense at 23:50 on 31 August while offline and
reconnects at 08:00 on 1 September — by which time `month:rollover` has archived `2026-08`
and cleared the live month. Invariant 7 says archives are immutable. Nothing in either spec
says where that entry goes.

**Timezone changes move month boundaries backwards.** `monthKey` is "user-local" and the
timezone is recaptured from the device on every login and refresh. A user flying Dubai →
Los Angeles on 1 September has `2026-08` already archived and the live month already reset,
while their local clock now says August again.

Separately, the prototype's archived entries store `day` (a day-of-month integer) while live
entries store `at` (epoch ms) — so its own comment claiming a finished month "can be filed
here untouched" is false; filing it loses the timestamp.

## Decision

1. **The server derives `monthKey` from `entryDate` in the user's stored timezone, at write
   time, and freezes it.** A client-supplied `monthKey` is never trusted. A later timezone
   change never re-files existing history.
2. **A write targeting a closed month is rejected with `MONTH_CLOSED`.** The client offers to
   re-file the entry into the live month, showing the real date rather than lying about it.
3. **`entryDate` is capped to the live month**, so the whole class of problem stays small.
4. **The live month is `max(currentLocalMonth, latestArchivedMonth + 1)`** — it can only ever
   move forward, never back into a sealed month. The unique `(userId, monthKey)` index
   already makes the double-archive direction safe; this covers the direction the index does
   not.
5. **Archived entries store the full `entryDate`**, not a day-of-month.

## Considered and rejected

- **Amend the archive and recompute its verdict.** The only option that genuinely erodes
  invariant 7 and reopens D6.
- **Silently re-file into the live month.** Misattributes August spending to September
  without telling anyone.
- **A grace window before sealing.** Breaks Product Spec §4.5's promise that a user opening
  the app on the 1st sees a fresh month and a new report.

## Consequences

- A user offline across a month boundary sees one rejected entry and an explicit prompt.
  Rare, visible, and honest — preferred over silent misfiling.
- Archives stay immutable with no exceptions, which keeps invariant 7 and the D6 fix
  unconditional.
- The archive is the permanent record, so storing full timestamps is the one place where
  discarding precision would be irreversible. Product Spec §3.6 requires "an accordion of
  every logged entry", and day-of-month cannot order two entries within a day.
- The `max(...)` live-month rule must be applied in one place (the repository), or a route
  will eventually compute the local month directly and reintroduce the backwards case.
