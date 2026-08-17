# ADR-0017 — The client's fixture corpus is the API contract, and drift is a build failure

**Status:** accepted, 13 August 2026
**Relates to:** iOS ADR-0003 (the client has no money formatter), iOS ADR-0027 (a blank `display`
string is a decode failure), `BACKEND_PLAN.md` §1.1

## Context

The usual order is API first, client second. Here it is reversed: all fifteen iOS screens were
converted before the first `/v1` route existed, and the client repo carries **37 JSON fixtures** that
are the exact response payloads for every screen in every state — `home-inr.json`,
`expenses-over-budget.json`, `reports-two-years.json`, `reports-empty.json`, `money-exponents.json`
— plus 35 endpoint declarations and a test (`FixtureCorpusTests`) that requires every `/v1` literal
in the client source to be claimed by a fixture.

So the contract is not up for invention. Every payload shape is already decided and already decoded
by working Swift. And because iOS ADR-0003 removed the client's formatter entirely, the fixtures also
decide things a schema normally would not: the pre-rendered `display` strings (`"₹5,539"`), the
`shareOfPayLabel` (`"9% of pay"`), the `percentageLabel` (`"177% of goal"`), the verdict enums, and
the "Today / Yesterday / N days ago" date labels are all **server deliverables**.

The risk this creates is drift. A payload key renamed on the server is a screen that renders nothing,
and it would be discovered by a human opening the app rather than by a build.

## Decision

**Copy the corpus into `test/contract/corpus/`, with the iOS commit it came from recorded, and make
every endpoint's definition of done "the fixture that describes it".**

Four parts:

**1 — The corpus is copied, not imported across repos.** `HisaabWiseBackend` and `HisaabWiseIOS` are
separate repos with separate remotes; a relative path between them works on a developer's laptop and
fails in CI. `npm run contract:sync` re-copies and records `syncedFromIosCommit`, and a drift check
fails the build if anything changed — so an iOS-side contract change surfaces as a **red backend
build** rather than as a bug report.

**2 — Coverage is derived from the client's source, not from a list.** `manifest.json` carries every
`/v1` literal extracted from the client, and `contract.test.ts` requires each to be covered by an
entry in `endpoints.ts`. This is iOS ADR-0027's argument in reverse: the failure mode of a
hand-maintained list is a green suite, so the list is checked against extraction rather than trusted.

**3 — Shape and formatting are asserted; figures are not.** A fixture's `553900` is one seeded user's
data and asserting it would make the suite a fixture-equality test. What `shape.ts` asserts is
everything a Swift `Decodable` actually depends on: every key present, every JSON type matching, and
every `Money` satisfying its own invariants — `minor` an integer, `currency` three letters,
`exponent` 0–3, and **`display` a non-empty string**. That last one is why `budget-drifted.json` is
in the corpus as a *negative* fixture: it carries a blank `display`, and the test asserts it fails
the check rather than passing one.

Extra keys in a response are allowed, because a Swift decoder ignores them and adding one is
backwards-compatible. Missing keys are not. A `null` in a fixture marks the field optional.

**4 — `status: 'pending' | 'live'` in `endpoints.ts` is the project tracker.** A pending endpoint is
`it.todo`, so the suite shows what is left without a permanently red build crying wolf. An entry
flips to `live` in the same commit that implements it, and from then on its slice's integration test
asserts the real response against the fixture.

## Consequences

- Client/server contract drift is a build failure in both directions.
- The definition of done for "build `GET /v1/screens/home`" is not prose, it is `home-inr.json`. That
  removes an entire category of argument from code review.
- The server owns formatting, and formatting is testable. The rounding ladder, symbol spacing,
  percentage labels, verdicts and date labels are all asserted rather than eyeballed in a simulator.
- The suite is honest about progress: 36 `todo` entries after slice 1 is a true statement about what
  the client can and cannot yet talk to.
- The cost is that a genuine, intentional contract change is now a two-repo change — fixture first,
  then `contract:sync`, then the server. That is the correct order and the correct friction.
