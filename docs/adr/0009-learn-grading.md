# ADR-0009 — Server re-grades every submission; XP only on first completion; the streak is evaluated lazily

**Status:** accepted
**Supersedes:** Technical Spec §4 (`learn_progress.done` shape), §5 (defines "impossible submissions")
**Relates to:** workspace invariant 10, defect D5

## Context

Technical Spec §5 requires the server to "recompute XP and reject impossible submissions"
without defining the predicate. The prototype supplies the mechanics — 3 hearts, run ends at
0, 10 XP per correct, 20 completion bonus, combo every 3rd consecutive correct — and three
problems:

- **Replays farm XP.** `state.xp += run.xp` runs unconditionally and `done[lessonId]` is
  overwritten, so a completed lesson can be replayed indefinitely for full XP.
- **Nothing resets the streak.** Product Spec §4.4 says "a missed day resets it", but the
  prototype only ever increments: `if (state.lastActive !== today) { state.streak += 1 }` —
  which increments even after a six-month gap. The reset is entirely new behaviour.
- **`dayKey` is UTC.** The prototype computes it as `toISOString().slice(0,10)`, which is
  defect D5 in situ.

Two further mismatches: numeric tolerance is a hardcoded **strict** `< 0.5` (both specs say
"±0.5", which reads as inclusive), and Technical Spec §4 specifies
`done{lessonId: {accuracy, xp}}` while the prototype stores `{correct, total}`.

## Decision

**Four validation rules for `POST /v1/learn/lessons/:id/complete`:**

1. **Recompute, never trust.** Grade every submitted per-question answer against the
   server's own answer key and derive XP from that, ignoring any client-supplied XP entirely.
2. **Heart arithmetic must close.** Wrong answers ≤ 3; if wrong answers = 3 the run is marked
   incomplete and earns no completion bonus.
3. **Shape validation.** Submitted question ids must be exactly the lesson's question set, in
   order, with no duplicates and no unknown ids. This catches most forgery without cleverness.
4. **XP on first completion only.** A lesson already in `done` may be replayed and may update
   `accuracy`, but grants no XP and no completion bonus. This closes the farm.

**Sequential unlocking is enforced server-side** — completing `u3l2` is rejected if `u3l1` is
not done. Rejections return `422` with a code and are logged as events, since a spike means
someone is probing.

**Numeric tolerance is `|submitted − correct| < 0.5`, strict**, matching the prototype
bit-for-bit. Grading is client-side for responsiveness and the server recomputes, so a `<`
versus `≤` divergence would reject a submission the client accepted, on exactly one input
value, intermittently. The constant lives in `src/domain/` with the strictness called out,
because it is the sort of thing a future reader "fixes" into `≤`. Per-question tolerance is
deliberately not added: a content-schema change across 14 questions for a problem nobody has
reported.

**The streak is evaluated lazily at read, with no job.** `learn_progress` stores `streak` and
`lastActiveDayKey`; on every read the server computes today's day-key in the user's stored
timezone and returns `streak` if `lastActiveDayKey` is today or yesterday, otherwise `0`. The
stored value is written only on completion. `dayKey` uses the stored IANA zone, never UTC and
never the device clock.

**`done` stores `{correct, total, xp}`**; `accuracy` is derived on read.

## Considered and rejected

- **A nightly streak-reset job.** Lazy evaluation is strictly better: correct for every
  timezone offset with no scheduled sweep, cannot drift if a run is skipped, correct on the
  first read after a timezone change, and a returning user sees `0` immediately rather than
  whenever a cron reaches them.
- **Storing `accuracy` directly.** It is a lossy rounding of `correct/total`, so the
  completion screen's percentage could never be recomputed or corrected.

## Consequences

- Replaying a lesson for practice is still allowed and still updates accuracy — only the XP
  reward is withheld. Retention mechanics stay intact; the exploit closes.
- The server must hold the full curriculum with answer keys to re-grade, which
  [ADR-0008](0008-content-delivery.md) already provides in-bundle at zero database cost.
- Lazy streak evaluation means `learn_progress.streak` at rest can be stale. Accepted and
  documented: the stored value is a checkpoint, the returned value is the truth.
- D5 is fixed structurally — no code path derives a day boundary from anything but the stored
  timezone.
