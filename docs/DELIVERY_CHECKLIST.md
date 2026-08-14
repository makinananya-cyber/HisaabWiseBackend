# Delivery checklist — every screen and capability

**As of 14 August 2026.** 45 endpoints live, 0 pending. 552 backend tests green, 20 files. Every payload is
asserted against the iOS fixture that describes it ([ADR-0017](adr/0017-contract-testing-against-the-ios-corpus.md)).

## Read this first: why the iOS column is almost empty

The client was built **before** the backend, against a corpus of 37 fixtures that then became the API
contract. All fifteen screens, five tabs, view models, networking and `URLSessionTransport` already existed
and already ran on the real transport — fixtures were only ever the seam tests and previews swap.

So "make the frontend work" turned out to be **one line**: the Debug base URL pointed at wrangler's old port
8787, and the Node backend listens on 8080. Everything else the client needed, the server was built to
provide. That is the fixture-first approach paying off, not an omission.

Total iOS diff this session: 5 files, +23/−14 lines.

---

## The checklist

Legend — **✅ Done** · **➖ None needed** (already built, now reading live) · **R** read · **W** write

| Feature | iOS change status | Backend change status | Database collections |
|---|---|---|---|
| **Landing** (galaxy, strapline rotation) | ➖ None needed | ➖ None — no server call | — |
| **Sign in** | ➖ None needed | ✅ `POST /v1/auth/login` — argon2id verify, per-account lockout, unknown email indistinguishable in body *and* timing | `users` R/W · `refresh_tokens` W |
| **Registration** (3 steps, atomic) | ➖ None needed | ✅ `POST /v1/auth/register` — one atomic call, 13+ gate, email uniqueness by index, answers hashed over normalised form | `users` W · `refresh_tokens` W · `events` W (install stitch) |
| **Forgot password / recovery** | ⚠️ **Screen not built** (client placeholder) | ✅ 3 routes: `forgot-password/questions`, `/verify`, `reset-password` — separate lockout, decoy questions for unknown email | `users` R/W · `password_resets` R/W · `refresh_tokens` W |
| **Session lifecycle** (rotation, foreground revalidate) | ➖ None needed | ✅ `POST /v1/auth/refresh` — family revocation on reuse; `GET /v1/me`; `sec` + `fam` claims | `users` R · `refresh_tokens` R/W |
| **Log out / log out all** | ➖ None needed | ✅ `POST /v1/auth/logout`, `/logout-all` — epoch bump makes it immediate | `users` W · `refresh_tokens` W |
| **Home** | ➖ None needed | ✅ `GET /v1/screens/home` — donut slots/shares, "% of pay", meter + verdict, day's tip, streak, teasers | `users` R · `expense_entries` R · `fixed_costs` R · `learn_progress` R · `fx_rates` R |
| **Expenses screen** | ➖ None needed | ✅ `GET /v1/screens/expenses` — 3-way summary, wants bar, 7 categories in 3 kinds, per-entry date labels | `users` R · `expense_entries` R · `fixed_costs` R · `month_archives` R · `fx_rates` R |
| **Add / delete expense** | ➖ None needed | ✅ `POST /v1/expenses`, `DELETE /v1/expenses/:id` — `Idempotency-Key` *is* the `_id`; label resolved from option id; `MONTH_CLOSED` guard | `expense_entries` R/W |
| **Rent (fixed cost)** | ➖ None needed | ✅ `GET/PUT /v1/expenses/fixed[/:categoryId]` | `fixed_costs` R/W |
| **Utility bill lines** | ➖ None needed | ✅ `GET/PUT /v1/expenses/lines[/:categoryId]` — whole set replaced, server-minted ids survive rename, icon derived from name | `fixed_costs` R/W |
| **Learn map** | ➖ None needed | ✅ `GET /v1/screens/learn` — streak, XP, next lesson, per-lesson state + ring counts, all **derived** not stored | `users` R · `learn_progress` R |
| **Lesson player** (mid-lesson save) | ➖ None needed | ✅ `GET/POST /v1/learn/progress` — position saved, earns nothing | `learn_progress` R/W |
| **Lesson completion** | ➖ None needed | ✅ `POST /v1/learn/lessons/:id/complete` — XP recomputed (10/correct + 20), first completion only, 5 refusals for impossible runs | `learn_progress` R/W |
| **Curriculum PDF** (offline takeaway) | ➖ None needed | ✅ `GET /v1/content/curriculum/pdf` — pdfkit, per (language, currency), ETag + 304 | — (content from disk) |
| **Reports list** | ➖ None needed | ✅ `GET /v1/screens/reports` — year groups, trend bars with fills + verdicts, goal line | `month_archives` R · `fx_rates` R |
| **Report — one month** | ➖ None needed | ✅ `GET /v1/screens/reports/:monthKey` — converted through the **pinned** rate set; 4-segment split; 6 facts | `month_archives` R · `fx_rates` R |
| **Pinned FX for a month** | ➖ None needed | ✅ `GET /v1/fx/rates/:monthKey` — immutable, long-cacheable | `month_archives` R · `fx_rates` R |
| **Account screen** | ➖ None needed | ✅ `GET /v1/screens/account` — initials by grapheme, 4 rows, "Changed 3 months ago" in stored zone | `users` R · `fx_rates` R |
| **Personal details** | ➖ None needed | ✅ `PUT /v1/me` — `PUT` not `PATCH`; **no email parameter** (invariant 4) | `users` R/W |
| **Display currency** | ➖ None needed | ✅ `PUT /v1/me/currency` — conversion attempted **before** storing | `users` R/W · `fx_rates` R |
| **Language** | ➖ None needed | ✅ `PUT /v1/me/language` — stored as well as sent, for push composed later | `users` R/W |
| **Password change** | ➖ None needed | ✅ `POST /v1/me/password` — one request not three; refusals are **422 never 401**; every *other* session revoked via `fam` claim | `users` R/W · `refresh_tokens` W |
| **Download my data** (PDPL) | ➖ None needed | ✅ `GET /v1/me/export` — every collection; `?format=csv&part=…`; CSV formula injection neutralised; question **ids** only, never answers | reads all 8 user collections |
| **Delete account** | ➖ None needed | ✅ `DELETE /v1/me` — soft, 30-day grace, email reserved, all sessions ended | `users` W · `refresh_tokens` W |
| **Tip of the day / "Show me another"** | ➖ None needed | ✅ Tip chosen server-side from day key + user id, stable within a day; pool cached client-side | — (content from disk) |
| **Article reader** | ➖ None needed | ✅ `GET /v1/content/articles`, `/articles/:id` — 3 articles, ETag | — (content from disk) |
| **Pickers** (country, currency, security Q) | ➖ None needed | ✅ 3 reference endpoints — 251 / 160 / 14, cacheable, unauthenticated | — (content from disk) |
| **Pick lists** (transport, other) | ➖ None needed | ✅ `GET /v1/content/picklists` — 22 + 20, `opensFreeText` as a flag not a regex | — (content from disk) |
| **Curriculum content** | ➖ None needed | ✅ `GET /v1/curriculum` — 5 units / 15 lessons / 124 steps, answer keys included | — (content from disk) |
| **Live FX rates** | ➖ None needed | ✅ `GET /v1/fx/rates` — newest set, cacheable; ⚠️ seeded from the design's snapshot, **not** a live provider | `fx_rates` R |
| **Product metrics** | ⚠️ **Not wired** (client sends none yet) | ✅ `POST /v1/events` — unauthenticated, name allowlist + declared-prop filter, `installId` stitching | `events` W |
| **Month rollover job** | ➖ N/A | ✅ `month:rollover`, 15 min — catch-up-safe, idempotent by unique index, clear driven by the archive | `users` R · `expense_entries` R/W · `fixed_costs` R · `month_archives` R/W · `fx_rates` R |
| **Purge job** | ➖ N/A | ✅ `purge:deleted`, daily — erases 8 collections, dependents before user, leaves a tombstone | all 8 + `deletion_tombstones` W |
| **Money domain** (cross-cutting) | ➖ None needed | ✅ `money.ts` — USD pivot, rounding ladder, symbol-vs-code rule, `{c}` resolution | reads `fx_rates` via callers |
| **Budget engine** (cross-cutting) | ➖ None needed | ✅ `budget.ts` — both 50/30/20 branches, one verdict table at 100/70 | — (pure) |
| **Time / day boundaries** | ➖ None needed | ✅ `time.ts` — day + month keys in stored IANA zone, tested at ½ and ¼ hour offsets | — (pure) |
| **Local dev wiring** | ✅ **Debug base URL 8787 → 8080** (+ 2 tests, 2 docs) | ➖ — | — |

---

## Database summary — 10 collections

| Collection | Purpose | Key indexes |
|---|---|---|
| `users` | Identity, **sole owner of salary** (invariant 2) | `{email}` unique · `{deletedAt}` sparse |
| `expense_entries` | Append-only log; `_id` is a client UUID = idempotency | `{userId, monthKey}` |
| `fixed_costs` | Rent + utility lines, carried forward at rollover | `{userId}` unique |
| `month_archives` | **Immutable** closed months | `{userId, monthKey}` **unique** — the rollover backbone |
| `learn_progress` | XP, streak checkpoint, `done` counts | `{userId}` unique |
| `fx_rates` | One dated set per day, all 160 codes or none | `{dateKey}` unique |
| `refresh_tokens` | Rotation chain + `familyId` | `{tokenHash}` unique · `{familyId}` · `{userId}` · `{expiresAt}` TTL |
| `password_resets` | Single-use recovery tickets | `{ticketHash}` unique · `{userId}` · `{expiresAt}` TTL |
| `events` | Product metrics, allowlisted | `{userId, receivedAt}` · `{installId}` sparse |
| `deletion_tombstones` | Evidence of erasure — hash + timestamp only | `{userIdHash}` unique |

Editorial content is **not** a collection — static, versioned with the deploy, served from disk, ETag'd
([ADR-0008](adr/0008-content-delivery.md)).

---

## Not done — carried forward

| Item | Where | Owner |
|---|---|---|
| Forgot-password **screen** in iOS | This backend defines the shape; the client screen is a placeholder | iOS |
| `POST /v1/events` **not called** by the client | Endpoint live so activation metrics are never backfilled | iOS |
| First-run `saved` reads "500% of goal" | [ADR-0019 §2](adr/0019-currency-token-and-the-first-run-residual.md) — spec implemented, 3 options given | Product |
| Live **FX provider** | Seed is the prototype's snapshot, not market data | Procurement |
| **Arabic** content | Plumbing in place (`Vary`, `resolveLanguage`); only `.en.json` exists | Translation |
| **Hosting** decision | `BACKEND_PLAN.md` §6 — recommendation B | Owner |
| Manual recovery for a locked-out user | A **compliance gap**: `DELETE /v1/me` needs a session | Owner |
| Streak push reminder (APNs) | Slice 8 | Backend |
| Rate limiting / WAF, Sentry, cache rules | Slice 8 | Backend |
