# ADR-0002 — Invariant 1 is enforced by a branded type, a lint rule, and a two-way zod boundary

**Status:** accepted
**Relates to:** [ADR-0001](0001-money-representation.md), workspace invariant 1

## Context

Dropping Mongoose removed the `Money` sub-schema that was supposed to *enforce* "every
monetary value is `{amount, currency}`". `DEVELOPMENT_PLAN.md` §1.1 says enforcement "moves
to a `Money` type + zod + a repository layer that is the only code touching collections" —
but "the only code touching collections" is a sentence, not a mechanism. Nothing in it
fails a build.

Invariant 1 exists because defect D1 (salary with no single source of truth) and D6 (history
silently reconverting) were both caused by raw numbers flowing between layers. If enforcement
is a convention, both defects can come back.

## Decision

Three layers, each mechanical:

1. **`Money` is a branded type.** `{readonly __brand: 'Money'; minor: number; currency:
   CurrencyCode; exponent: number}`, constructible only through `money()` in
   `src/types/money.ts`. A bare number cannot be assigned to a money-typed field, so
   `tsc --noEmit` catches the violation.
2. **An ESLint `no-restricted-imports` rule** forbids importing `src/db` from anywhere
   outside `src/repositories/`. "Repositories are the only code touching collections"
   becomes a lint failure rather than a code-review hope.
3. **Repositories are the zod boundary in both directions.** Every document is parsed on
   read as well as validated on write. A document with a bare-number monetary field — from
   a seed script, a hand edit, or an older deploy — throws at the boundary instead of
   flowing into the budget engine.

Plus the test `DEVELOPMENT_PLAN.md` §8 already calls for: a case asserting that a
bare-number monetary field is rejected.

## Consequences

- Three independent gates, each catching a different class of mistake: the type catches
  authoring errors, the lint rule catches architectural drift, the read-side parse catches
  bad data already at rest.
- Parsing on read costs CPU on every query. Accepted — the alternative is trusting the
  database, which is what invariant 1 exists to stop.
- The branded type is slightly awkward to construct in tests. Accepted; a `money()` helper
  and a fixture builder absorb most of it.
- Any future code that genuinely needs raw collection access must live in
  `src/repositories/` or explicitly amend the lint rule, which makes the exception visible
  in a diff.
