# Data model

**Status:** proposed, 13 August 2026
**Companion to:** [BACKEND_PLAN.md](BACKEND_PLAN.md) · **Vocabulary:** [CONTEXT.md](../CONTEXT.md)
**Derived from:** Technical Spec §4, its `[AMENDED]` rows, the decisions in ADR-0001…0015, and the
37-fixture contract corpus in `HisaabWiseIOS/HisaabWise/HisaabWise/Fixtures/Resources/`

Where the Technical Spec and the fixture corpus disagree, **the corpus wins** — it is what working
Swift already decodes. Those disagreements are listed in §7.

---

## 1. Four rules that shape every collection

**1 — Every monetary value is an embedded `Money`, never a bare number.**

```js
{ minor: 553900, currency: "INR", exponent: 2 }
```

`minor` is an integer count of the currency's smallest unit, stored **in the currency it was authored
in**. Never a float. Never normalised to a base on write. `exponent` comes from
`content/reference/currencies.json` — 2 for AED/USD/INR, 3 for KWD/BHD/OMR, 0 for JPY/KRW — and is
never guessed. USD is the conversion **pivot**, not a storage currency (ADR-0001).

The `display` string the fixtures carry (`"₹5,539"`) is **never stored**. It is a render-time function
of the user's display currency and the rate set in force, and storing it would be defect D16 — salary
round-tripping through display rounding.

**2 — Repositories are the only code that touches collections.** Enforced by the
`no-restricted-imports` lint rule already live in `eslint.config.mjs`, plus zod parsing at the
boundary **on read as well as write** — so a bare-number monetary field written by a seed script or an
older deploy throws at the boundary instead of flowing into the budget engine (ADR-0002).

**3 — Store what cannot be recomputed; derive everything else.** The fixtures are full of figures
(`shareLabel`, `percentageLabel`, `entryCountLabel`, `fill`, `slot`, per-category totals) that are
**not** columns. They are computed by the screen endpoint. The exception is a **closed month**, where
`saved`, `net` and `verdict` are sealed at close precisely so a later FX movement cannot rewrite the
story (invariant 7).

**4 — Two databases, one cluster.** `hisaabwise_dev` (local + staging) and `hisaabwise_prod`. Tests
create and drop `hisaabwise_test_<runId>`, guarded to refuse a production URI and any database name
lacking `_test_` (ADR-0014).

---

## 2. The category taxonomy

This is the part most likely to be got wrong, and the fixtures settle it. **Seven categories in three
kinds** — the kind determines which collection holds the data and which endpoint writes it.

| id | kind | flow | Free-text field | Storage |
|---|---|---|---|---|
| `groceries` | `log` | out | — | `expense_entries` |
| `transport` | `log` | out | 22-item pick list + free text | `expense_entries` |
| `entertainment` | `log` | out | free text | `expense_entries` |
| `other` | `log` | out | 20-item pick list + free text | `expense_entries` |
| `income` | `log` | **in** | free text | `expense_entries` |
| `utilities` | `lines` | out | named lines | `fixed_costs.utilityLines[]` |
| `rent` | `fixed` | out | — | `fixed_costs.rent` |

- **`log`** — append-only, many entries per month, each individually deletable.
- **`lines`** — a small set of named recurring amounts, edited in place, carried forward at rollover.
- **`fixed`** — one amount, edited in place, carried forward at rollover.

`income` is **additional** income and is the only `flow: "in"` category. It is not salary; salary
lives on the user document and has exactly one owner (invariant 2). Per the O1 resolution,
`income = salary + additionalIncome` and the 50/30/20 split runs against that total, so additional
income lifts all three allowances.

**Needs / wants grouping**, which the budget engine depends on: **needs** = `rent` + `utilities` +
`groceries`; **wants** = `transport` + `entertainment` + `other`.

---

## 3. Collections

Nine, plus a tombstone collection (§3.10). `email_verifications` is dropped with email verification;
`content` was dropped by ADR-0008.

### 3.1 `users`

The identity record, and the single owner of salary.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `email` | string | **unique, lowercased, immutable.** The identity (invariant 4) |
| `emailVerifiedAt` | Date | Set at registration. Nothing is verified out of band, but the field stays so the client's `emailVerified` contract is unchanged and verification is addable later |
| `passwordHash` | string | argon2id, m=19 MiB / t=2 / p=1, env-tunable |
| `passwordChangedAt` | Date | **Not in the Technical Spec.** Required — `account-*.json` renders `"Changed 3 months ago"` on the password row |
| `displayName` | string | Surfaced as "Username". Not an identifier |
| `phone` | string? | E.164, optional, **collected and never verified** (O2) |
| `dob` | Date | 13+ gate at registration; also the third factor on password recovery |
| `salary` | Money | Server-owned. No screen may hardcode it (defect D1) |
| `savingsGoal` | Money | |
| `goalWasSkipped` | bool | Submit and Skip differ only by this |
| `displayCurrency` | string | Read-time concern only; changing it converts nothing at rest |
| `language` | string | `en` \| `ar` |
| `timezone` | string | **IANA, captured from the device on login and refresh.** Rollover, day keys and streaks all depend on it; never UTC, never the device clock (invariant 6) |
| `securityQuestions` | `[{questionId, answerHash}]` | Exactly 2. `questionId` is an opaque `sq01`…`sq14`; the English text is localisable display content and never an identifier. `answerHash` is argon2id over the **normalised** answer, never the raw string (invariant 5) |
| `securityEpoch` | int | Minted into every access token as `sec`. Incremented on password change, `logout-all`, deletion — a mismatch invalidates outstanding access tokens immediately rather than after 15 minutes |
| `failedLoginCount` | int | **Per-account**, updated atomically. An IP-keyed limiter structurally cannot do "3 failed attempts" (ADR-0010) |
| `lockedUntil` | Date? | |
| `recoveryFailedCount`, `recoveryLockedUntil` | int, Date? | Separate counters for the recovery flow — it is now the only way back into an account, so it needs its own lockout rather than sharing login's |
| `pushTokens` | `[{deviceId, token}]` | |
| `streakOptIn` | bool | |
| `deletedAt` | Date? | Soft delete: sign-in blocked, email still reserved, recovery possible |
| `createdAt` | Date | |

**Indexes:** `{email: 1}` unique · `{deletedAt: 1}` sparse (drives `purge:deleted`)

### 3.2 `expense_entries`

Append-only. One document per logged entry, for the five `log` categories.

| Field | Type | Notes |
|---|---|---|
| `_id` | **string (UUID), supplied by the client** | **This is the idempotency mechanism.** A duplicate insert is `E11000` → "already recorded", so no key store is needed (ADR-0011) |
| `userId` | ObjectId | |
| `monthKey` | string | `YYYY-MM`, **server-derived from `entryDate` in the user's timezone at write time and frozen thereafter.** Never supplied by the client |
| `category` | enum | `groceries` \| `transport` \| `entertainment` \| `other` \| `income` |
| `amount` | Money | |
| `label` | string | The pick-list value or free text |
| `entryDate` | Date | A full timestamp, not a day-of-month |
| `createdAt` | Date | |

**Indexes:** `{userId: 1, monthKey: 1}` — every read is scoped to a month

A write whose `monthKey` resolves to a closed month is rejected `MONTH_CLOSED` (ADR-0006).

### 3.3 `fixed_costs`

One document per user, holding the `fixed` and `lines` kinds. Carried forward at rollover.

| Field | Type |
|---|---|
| `userId` | ObjectId |
| `rent` | Money |
| `utilityLines` | `[{name: string, amount: Money}]` |
| `updatedAt` | Date |

**Indexes:** `{userId: 1}` unique

### 3.4 `month_archives`

**Immutable.** The most carefully designed document in the system, because rollover writes it and
Reports reads it forever.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId | |
| `monthKey` | string | |
| `salary`, `goal` | Money | As they stood at close |
| `saved`, `net` | Money | **Sealed, not recomputed.** `saved = max(0, income − needs − wantsSpent)`; `net` is the same unclamped, so it can be negative |
| `verdict` | enum | `hit` \| `near` \| `miss`, from one threshold table (≥100% / ≥70%) |
| `adapted` | bool | True when needs exceeded 50% of income, so allowances came from the degradation branch |
| `entries` | `[{ _id, category, amount: Money, label, entryDate }]` | Full payload, each carrying a **full `entryDate`**, not a day-of-month |
| `fixed` | `{ rent: Money, utilityLines: [...] }` | Snapshot at close |
| `fxRateSetId` | ObjectId | **Pinned.** All conversion of this month uses this set forever, so later FX movement cannot rewrite history (invariant 7, defect D6) |
| `closedAt` | Date | |

**Indexes:** `{userId: 1, monthKey: 1}` **unique — the idempotency backbone of the rollover job.** A
retry cannot double-write.

**Why `saved`/`net`/`verdict`/`adapted` are stored when rule 3 says derive:** these four are the
month's *story*. Changing display currency must convert the figures without ever changing whether the
goal was met. Recomputing them against a different rate set could flip a `hit` to a `near`, which is
exactly defect D6. Everything else on `reports-month-*.json` — per-category totals and slots, the
four split-bar segments, the six "For the record" facts, every label — is derived from the stored
entries at read time.

### 3.5 `learn_progress`

One document per user. Survives reinstall because it is server-owned.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId | |
| `xp` | int | Server-recomputed from its own answer keys; client-supplied XP is ignored |
| `streak` | int | **A checkpoint at rest.** The *returned* value is evaluated lazily against `lastActiveDayKey` in the stored timezone, so no nightly job is needed and a device-clock change cannot move it |
| `lastActiveDayKey` | string | `YYYY-MM-DD`, user-local |
| `done` | `{ [lessonId]: { correct, total, xp } }` | Counts stored, **`accuracy` derived on read** — storing a rounded accuracy makes it unrecomputable. Presence also gates the first-completion-only XP rule (defect D13) |
| `progress` | `{ [lessonId]: stepIndex }` | Partial position, for resuming mid-lesson |

**Indexes:** `{userId: 1}` unique

Unit unlocking and each lesson's `state` / `filledSegments` in `learn-*.json` are **derived** from
`done` and `progress` against the bundled curriculum — not stored, so a curriculum change cannot leave
stale state behind.

### 3.6 `fx_rates`

| Field | Type | Notes |
|---|---|---|
| `dateKey` | string | `YYYY-MM-DD`, one document per day |
| `base` | `"USD"` | The pivot |
| `rates` | `{ [code]: number }` | Units per 1 USD |
| `fetchedAt` | Date | |

**Indexes:** `{dateKey: 1}` unique

**Written only if every code in `currencies.json` is present.** A partial set silently breaks some
user's display currency, which is indistinguishable from the hardcoded fallback §6.1 already forbids.
An unknown code at conversion time is an error, never rate 1.0 (defect D15).

### 3.7 `refresh_tokens`

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId | |
| `tokenHash` | string | **SHA-256, not argon2** — these are high-entropy 32-byte CSPRNG values, and argon2 on the refresh path would burn CPU on every app foreground |
| `familyId` | UUID | Every token descended from one login. **This is what makes "reuse of a revoked token revokes the family" implementable** — `deviceId` cannot serve, it is client-supplied and spoofable |
| `replacedBy` | ObjectId? | The rotation chain |
| `deviceId` | string | Client-supplied, informational only |
| `expiresAt` | Date | ~60 days |
| `revokedAt` | Date? | |

**Indexes:** `{tokenHash: 1}` unique · `{familyId: 1}` · `{userId: 1}` · `{expiresAt: 1}` TTL

### 3.8 `password_resets`

Repurposed by the recovery decision: it holds **server-issued reset tickets**, not emailed tokens.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId | |
| `ticketHash` | string | SHA-256. Issued only after email + both security answers + DOB verify |
| `expiresAt` | Date | Short — minutes |
| `usedAt` | Date? | **Single use** |
| `createdAt`, `createdIp` | Date, string | For the alert on every successful reset |

**Indexes:** `{ticketHash: 1}` unique · `{expiresAt: 1}` TTL

### 3.9 `events`

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId? | |
| `installId` | string? | Stitched to `userId` at registration, so pre-account activation is measurable |
| `name` | string | **Allowlisted**, with declared prop keys — writes are unauthenticated |
| `props` | object | |
| `clientTs`, `receivedAt` | Date | |

**Indexes:** `{userId: 1, receivedAt: -1}` · `{receivedAt: 1}` TTL if volume demands

### 3.10 `deletion_tombstones`

| Field | Type |
|---|---|
| `userIdHash` | string |
| `purgedAt` | Date |

So erasure is **evidenced** rather than merely invisible. The Technical Spec requires the tombstone in
§6.4 but omitted it from its own collection count — noted rather than quietly folded in.

---

## 4. Index summary

| Collection | Index | Why |
|---|---|---|
| `users` | `{email: 1}` unique | email is the identity |
| `users` | `{deletedAt: 1}` sparse | `purge:deleted` selection |
| `expense_entries` | `{userId: 1, monthKey: 1}` | every read is month-scoped |
| `fixed_costs` | `{userId: 1}` unique | one per user |
| `month_archives` | `{userId: 1, monthKey: 1}` **unique** | **rollover idempotency** |
| `learn_progress` | `{userId: 1}` unique | one per user |
| `fx_rates` | `{dateKey: 1}` unique | one per day |
| `refresh_tokens` | `{tokenHash: 1}` unique, `{familyId: 1}`, `{expiresAt: 1}` TTL | lookup, family revocation, expiry |
| `password_resets` | `{ticketHash: 1}` unique, `{expiresAt: 1}` TTL | single-use tickets |
| `events` | `{userId: 1, receivedAt: -1}` | metrics reads |

The unique index on `month_archives` and the client-supplied UUID `_id` on `expense_entries` are not
optimisations — they are the two idempotency mechanisms the system relies on instead of a key store.

---

## 5. Which slice creates what

| Slice | Collections |
|---|---|
| 2 — Identity | `users`, `refresh_tokens`, `password_resets` |
| 3 — Money + Home | `fx_rates` |
| 4 — Expenses | `expense_entries`, `fixed_costs` |
| 5 — Learn | `learn_progress` |
| 6 — Reports | `month_archives` |
| 7 — Account | `events`, `deletion_tombstones` |

Indexes are created by an idempotent `ensureIndexes` run at startup, so a fresh database and a
migrated one converge. No migration framework at launch: nine collections, none of them yet carrying
production data.

---

## 6. What is deliberately *not* a collection

- **Editorial content** — tips, articles, curriculum, reference lists. Static, identical for every
  user, versioned with the deploy, ETag'd. Serving it from Mongo would spend a connection on the four
  most cacheable endpoints (ADR-0008).
- **Idempotency keys** — the client UUID and the unique archive index do the work (ADR-0011).
- **Streak job state** — the streak is evaluated lazily, so there is nothing to checkpoint beyond
  `lastActiveDayKey`.
- **Sessions** — access tokens are stateless JWTs; `securityEpoch` is the revocation mechanism.
- **`saved` as a user-writable field** — it is derived, never entered, and a grep asserting no route or
  job accepts a client-supplied `saved` is part of the verification checklist.

---

## 7. Where this departs from the Technical Spec

Found while reconciling §4 against the fixture corpus. Each needs a line in `docs/api.md` or an ADR.

| # | Spec says | Corpus / decision says | Resolution |
|---|---|---|---|
| 1 | `expense_entries.category` enum includes `additional_income` | `expenses-inr.json` and `reports-month-inr.json` both use **`income`** | **`income`.** The client already decodes it |
| 2 | `users` has no password-change timestamp | `account-*.json` renders `"Changed 3 months ago"` | Add **`passwordChangedAt`** |
| 3 | Ten collections including `email_verifications` | Email verification dropped 13 Aug | **Nine**, plus `deletion_tombstones` |
| 4 | `password_resets` holds emailed tokens | Recovery is by security question | Same collection, now holds **single-use reset tickets** |
| 5 | Login lockout counters only | Recovery is now the sole way back into an account | Add **`recoveryFailedCount` / `recoveryLockedUntil`**, separate from login's |
| 6 | Tombstone required in §6.4 but absent from the collection count | — | `deletion_tombstones`, counted honestly |
| 7 | `month_archives` stores `saved` and `net` | Fixtures also render `verdict` and `isAdapted` for closed months | Store **`verdict`** and **`adapted`** too — recomputing them against a different rate set could flip a met goal, which is defect D6 |
