# ADR-0001 — Money is stored as authored, in integer minor units

**Status:** accepted
**Supersedes:** Technical Spec §4 (`amount: Number`), Product Spec §3.4 ("stored in base"), §4.1 (rounding ladder)

## Context

The specs said two incompatible things about storage. Product Spec §4.1 and Technical Spec §4
say every value is `{amount, currency}` — the currency travels with the value. Product Spec
§3.4 says amounts are "typed in display currency, **stored in base**", with base = USD.

They are different systems, and the second one has a user-visible defect: a UAE user types
`AED 500` rent, we store `USD 136.15`, and next month they see `AED 501` because the rate
moved. A user's own figures must never move on their own.

Separately, Technical Spec §4 specified `amount: Number` — an IEEE-754 double. Summing
entries and taking percentages of them accumulates error, which makes an exactly-at-goal
month non-deterministic. The prototype compounds this: salary is read via
`M.from(M.to(salary, SALARY_BASE), BASE)`, round-tripping through **display rounding**
before it reaches the budget engine.

## Decision

1. **Store money exactly as authored.** `{minor, currency, exponent}`. Never converted on
   write, never rewritten when display currency changes. USD is the conversion **pivot**,
   not a storage base.
2. **`minor` is an integer count of the currency's smallest unit.** `exponent` comes from
   `content/reference/currencies.json` — 2 for most, 3 for KWD/BHD/OMR, 0 for JPY/KRW.
3. **Convert once, at read.** Aggregation uses the live rate set for the live month and the
   pinned rate set for a closed month. Salary never round-trips through display rounding.
4. **The wire format is `{minor, currency, exponent}`** — never a pre-divided decimal, so
   the client cannot re-derive precision incorrectly.
5. **Display rounds to whole units**, matching the prototype: ≥100,000 → nearest 100;
   ≥10,000 → nearest 10; otherwise → nearest whole unit. `AED 500`, never `AED 500.00`.
6. **Symbol spacing:** multi-character symbols get a space (`AED 500`), single-character
   ones do not (`₹500`).
7. **An unknown currency code is an error.** The prototype silently falls back to rate 1.0,
   which reports a foreign amount as if it were USD.

## Consequences

- If a user's entries and display currency are all AED, every conversion is the identity
  and nothing wobbles — the common case is exactly stable.
- Product Spec §4.1's "sensible minor-unit rounding" is wrong for this product and is
  replaced by whole-unit rounding. Storage stays exact; only display rounds.
- Displayed category totals may not visually sum to a displayed grand total. Mitigation:
  round only at the leaves and derive totals from unrounded values, so the total is right.
- Cross-currency aggregation is now a read-time cost on every budget call. Acceptable: the
  rate set is one small document, cacheable per request.
- Deterministic verdicts: a goal-met evaluation on the same data always returns the same
  answer, which is what makes ADR-0003's verdict trustworthy and D6 fixable.
