# MVP status — feature by feature

**Date:** 2026-08-14 · **Branch:** `feature/mvp`

---

## Read this first — why the iOS column is nearly empty

The client was built **before** the backend, against **37 fixtures** that then became the API
contract. All fifteen screens already existed and already ran on the real
`URLSessionTransport`. So "make the frontend work" came down to one line: Debug pointed at
`wrangler`'s old port `8787`, the Node server listens on `8080`.

**Total iOS diff this session: 5 files, +23 / −14 lines.**

That is the fixture-first approach paying off, not an omission.

### Legend

| Symbol | Meaning |
|---|---|
| ✅ | Done this session |
| ➖ | No change needed — already built, now reading live |
| ⚠️ | Gap |
| R / W | Reads / writes the collection |

---

## Auth and session

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Landing | ➖ None needed | ➖ No server call | — |
| Sign in | ➖ None needed | ✅ `POST /v1/auth/login` — argon2id, per-account lockout, unknown email identical in body **and** timing | `users` R/W · `refresh_tokens` W |
| Registration (3 steps) | ➖ None needed | ✅ `POST /v1/auth/register` — atomic, 13+ gate, uniqueness by index | `users` W · `refresh_tokens` W · `events` W |
| Forgot password | ⚠️ **Screen not built** | ✅ 3 routes — separate lockout, decoy questions for unknown email | `users` R/W · `password_resets` R/W · `refresh_tokens` W |
| Session / rotation | ➖ None needed | ✅ `POST /v1/auth/refresh`, `GET /v1/me` — family revocation on reuse; `sec` + `fam` claims | `users` R · `refresh_tokens` R/W |
| Log out / log out all | ➖ None needed | ✅ 2 routes — epoch bump makes it immediate | `users` W · `refresh_tokens` W |

## Home and expenses

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Home | ➖ None needed | ✅ `GET /v1/screens/home` — donut, "% of pay", meter, tip, streak, teasers | `users` · `expense_entries` · `fixed_costs` · `learn_progress` · `fx_rates` (all R) |
| Expenses screen | ➖ None needed | ✅ `GET /v1/screens/expenses` — summary, wants bar, 7 categories, date labels | `users` · `expense_entries` · `fixed_costs` · `month_archives` · `fx_rates` (R) |
| Add / delete expense | ➖ None needed | ✅ 2 routes — `Idempotency-Key` **is** the `_id`; `MONTH_CLOSED` guard | `expense_entries` R/W |
| Rent | ➖ None needed | ✅ `GET`/`PUT /v1/expenses/fixed[/:categoryId]` | `fixed_costs` R/W |
| Utility lines | ➖ None needed | ✅ `GET`/`PUT /v1/expenses/lines[/:categoryId]` — whole set replaced, ids survive rename | `fixed_costs` R/W |

## Learn

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Learn map | ➖ None needed | ✅ `GET /v1/screens/learn` — states derived, not stored | `users` R · `learn_progress` R |
| Lesson player | ➖ None needed | ✅ `GET`/`POST /v1/learn/progress` — earns nothing | `learn_progress` R/W |
| Lesson completion | ➖ None needed | ✅ `POST …/complete` — XP recomputed, first-only, 5 refusals | `learn_progress` R/W |
| Curriculum PDF | ➖ None needed | ✅ `GET /v1/content/curriculum/pdf` — pdfkit, ETag + 304 | — (disk) |

## Reports

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Reports list | ➖ None needed | ✅ `GET /v1/screens/reports` — year groups, trend bars, goal line | `month_archives` R · `fx_rates` R |
| Report — one month | ➖ None needed | ✅ `GET …/reports/:monthKey` — via the pinned rate set | `month_archives` R · `fx_rates` R |
| Pinned FX | ➖ None needed | ✅ `GET /v1/fx/rates/:monthKey` — immutable | `month_archives` R · `fx_rates` R |

## Account

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Account screen | ➖ None needed | ✅ `GET /v1/screens/account` — grapheme initials, 4 rows, "Changed 3 months ago" | `users` R · `fx_rates` R |
| Personal details | ➖ None needed | ✅ `PUT /v1/me` — **no email parameter** (invariant 4) | `users` R/W |
| Display currency | ➖ None needed | ✅ `PUT /v1/me/currency` — converts before storing | `users` R/W · `fx_rates` R |
| Language | ➖ None needed | ✅ `PUT /v1/me/language` — stored as well as sent | `users` R/W |
| Password change | ➖ None needed | ✅ `POST /v1/me/password` — one request; **422 never 401**; other sessions revoked via `fam` | `users` R/W · `refresh_tokens` W |
| Download my data | ➖ None needed | ✅ `GET /v1/me/export` — all collections, CSV parts, formula injection neutralised, question ids only | reads all 8 user collections |
| Delete account | ➖ None needed | ✅ `DELETE /v1/me` — soft, 30-day grace, email reserved | `users` W · `refresh_tokens` W |

## Content

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Tip of the day | ➖ None needed | ✅ Chosen from day key + user id, stable within a day | — (disk) |
| Article reader | ➖ None needed | ✅ 2 routes, 3 articles | — (disk) |
| Pickers (251 / 160 / 14) | ➖ None needed | ✅ 3 reference endpoints, unauthenticated | — (disk) |
| Pick lists (22 + 20) | ➖ None needed | ✅ `opensFreeText` a flag, not a runtime regex | — (disk) |
| Curriculum | ➖ None needed | ✅ 5 units / 15 lessons / 124 steps | — (disk) |
| Live FX | ➖ None needed | ✅ `GET /v1/fx/rates`; ⚠️ **seeded snapshot, not a provider** | `fx_rates` R |
| Product metrics | ⚠️ **Not wired** | ✅ `POST /v1/events` — allowlist, `installId` stitching | `events` W |

## Jobs, domain, and plumbing

| Feature | iOS | Backend | Collections |
|---|---|---|---|
| Rollover job | ➖ N/A | ✅ Every 15 min — catch-up-safe, idempotent, clear driven by the archive | `users` · `expense_entries` R/W · `fixed_costs` · `month_archives` R/W · `fx_rates` |
| Purge job | ➖ N/A | ✅ Daily — 8 collections, dependents first, tombstone | all 8 + `deletion_tombstones` W |
| Money domain | ➖ None needed | ✅ USD pivot, rounding ladder, symbol-vs-code rule | via callers |
| Budget engine | ➖ None needed | ✅ Both branches, one verdict table at 100 / 70 | — (pure) |
| Time / day keys | ➖ None needed | ✅ Stored IANA zone, tested at ½ and ¼ hour offsets | — (pure) |
| Local dev wiring | ✅ 8787 → 8080 + 2 tests, 2 docs | ➖ — | — |

---

## The 10 collections

| Collection | Key indexes |
|---|---|
| `users` — **sole owner of salary** | `{email}` unique · `{deletedAt}` sparse |
| `expense_entries` — `_id` is a client UUID = idempotency | `{userId, monthKey}` |
| `fixed_costs` | `{userId}` unique |
| `month_archives` — **immutable** | `{userId, monthKey}` unique — the rollover backbone |
| `learn_progress` | `{userId}` unique |
| `fx_rates` | `{dateKey}` unique |
| `refresh_tokens` | `{tokenHash}` unique · `{familyId}` · `{userId}` · `{expiresAt}` TTL |
| `password_resets` | `{ticketHash}` unique · `{userId}` · `{expiresAt}` TTL |
| `events` | `{userId, receivedAt}` · `{installId}` sparse |
| `deletion_tombstones` | `{userIdHash}` unique |

Editorial content is **deliberately not a collection** — static, versioned with the deploy,
ETag'd.

---

## Three gaps in the "done" column worth naming

1. **Forgot-password screen** is the one place the backend led and iOS hasn't followed. The
   routes are live and the shape is documented in `endpoints.ts`, but the client screen is
   still a placeholder.
2. **`POST /v1/events` is live but nothing calls it.** Built in slice 7 rather than slice 8
   precisely because activation metrics can't be backfilled — but that only pays off once the
   client sends them.
3. **First-run `saved` reads "500% of goal"** — still an open decision, ADR-0019 §2.
