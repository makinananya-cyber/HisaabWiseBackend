# CONTEXT — HisaabWiseBackend

Glossary for the backend. These terms have precise meanings; use them exactly, in code,
tests, issues, and API fields. Where a term has a tempting synonym, the synonym is named
and rejected.

Decisions that established these terms live in `docs/adr/`.

## Money

**Money** — a value object `{minor: number, currency: CurrencyCode, exponent: number}`.
`minor` is an integer count of the currency's smallest unit (fils, cents). Never a bare
number, never a float. Constructed only via `money()` in `src/types/money.ts`.
See [ADR-0001](docs/adr/0001-money-representation.md).

**exponent** — how many decimal places the currency has. 2 for AED/USD/INR, 3 for
KWD/BHD/OMR, 0 for JPY/KRW. Derived from `content/reference/currencies.json`, never guessed.

**authored currency** — the currency a value was entered in. Money is stored exactly as
authored and never rewritten. Rejected synonym: *base currency* (the app has no storage
base; USD is only the conversion pivot).

**pivot** — USD. The intermediate through which conversion happens (`from → USD → to`).
Not a storage currency.

**display currency** — the currency the user has selected for viewing. A read-time
concern only. Changing it converts nothing on disk.

**rate set** — one `fx_rates` document: a dated map of currency code → units per 1 USD,
covering every code in `currencies.json`. Partial sets are never written.

**pinned rate set** — the `fx_rates` document referenced by an archived month
(`fxRateSetId`), used for all conversion of that month forever. Prevents history from
being rewritten by later FX movement.

## Budget

**income** — `salary + additionalIncome` for the month.

**needs** — rent + utilities + groceries.

**wants** — transport + entertainment + other. Note: *wants* names the **category group**;
the allowance is `wantsAllowance`.

**wantsAllowance** / **savingsAllowance** — the amounts the 50/30/20 engine permits. The
prototype called these `wants` and `savings`; those names are rejected because they collide
with the category group and with `saved`.

**adapted** — true when `needs > 50% of income`, so allowances came from the degradation
branch (`remainder / 2` each) rather than the plain 30/20 split.

**saved** — `max(0, income − needs − wantsSpent)`. **Derived, never stored, never entered.**
The residual after all spending. Clamped at zero.
See [ADR-0003](docs/adr/0003-budget-outputs.md).

**net** — the same quantity *unclamped*, so it can be negative. What an overspending user
is actually told.

**surplus** — `max(0, saved − goal)`. The fourth segment of the split bar.

**verdict** — `hit` (≥100% of goal) | `near` (≥70%) | `miss`. Server-computed, one
threshold table, returned to the client. The client never derives it.

## Time

**live month** — the month a user is currently logging into. Computed as
`max(currentLocalMonth, latestArchivedMonth + 1)` — it only ever moves forward.

**closed month** — a month with a `month_archives` document for that user. Immutable.
Writes targeting it are rejected with `MONTH_CLOSED`.

**monthKey** — `YYYY-MM`, derived server-side from `entryDate` in the user's stored
timezone **at write time** and frozen thereafter. Never supplied by the client.

**dayKey** — `YYYY-MM-DD` in the user's stored IANA timezone. Never derived from UTC and
never from the device clock. See [ADR-0009](docs/adr/0009-learn-grading.md).

## Identity

**email** — the identity. Unique, lowercased, immutable after registration.

**displayName** — the profile name. Surfaced in the UI as "Username". Not an identifier.
Rejected synonym: *username*.

**securityEpoch** — an integer on the user document, incremented on password change,
`logout-all`, and account deletion, and minted into every access token as the `sec` claim.
A mismatch invalidates the token immediately.
See [ADR-0005](docs/adr/0005-session-lifecycle.md).

**token family** — every refresh token descended from one login, sharing a `familyId`.
Presenting an already-revoked token revokes the entire family.

**questionId** — an opaque stable id (`sq01`…`sq14`) for a security question. The English
text is localisable display content and is never an identifier.

**normalised answer** — a security answer reduced to its canonical form (accent-strip,
lowercase, de-apostrophe, de-punctuate, drop short and filler words, singularise, sort,
join) before hashing. Comparison is exact on the normalised form.

**soft delete** — `deletedAt` set; sign-in blocked, email still reserved, recovery
possible. **hard erase** — all documents removed by `purge:deleted` after 30 days, leaving
only a tombstone.

## Content

**content** — versioned editorial JSON in `content/`, bundled into the Worker at build
time. Not a database collection. See [ADR-0008](docs/adr/0008-content-delivery.md).

**step** — one screen in a lesson. Either `teach` or `q`. There are exactly **124**
(58 teach + 66 question).

**answer key** — the correct answer, shipped to the client deliberately so lessons work
offline. The server re-grades regardless.
