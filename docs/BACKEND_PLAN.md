# Backend plan — one plan, all screens

**Status:** proposed, 13 August 2026
**Supersedes:** `DEVELOPMENT_PLAN.md` §1.1 (the runtime substitution table), `DEVELOPMENT_PLAN.md` §7
(O1–O3 are resolved in §9.1), and the ticket-per-task structure of issues #1–#16
**Retains:** the `/v1` contract, the domain formulae, the verification checklist, and every ADR not
listed in §3.3. **Nine collections, not ten** — `email_verifications` is dropped with email
verification (§4.2.1)
**Schema:** [DATA_MODEL.md](DATA_MODEL.md) — every collection, field, index, and the seven places it
departs from Technical Spec §4

This replaces the ticket sequence with one screen-driven plan. The ordering below is not a
re-sequencing of the old phases — it follows what the already-built iOS client needs, in the order
it needs it.

---

## 1. The finding that shapes this plan

**The backend's specification already exists, and it is executable.**

`HisaabWiseIOS/` is not waiting to be built. All fifteen screens are converted (ADR-0029…0038), and
the repo carries:

- **37 JSON fixtures** in `HisaabWise/HisaabWise/Fixtures/Resources/` — exact response payloads for
  every screen in every state: `home-inr.json`, `home-first-run.json`, `expenses-over-budget.json`,
  `reports-two-years.json`, `reports-empty.json`, `account-aed.json`, `budget-drifted.json`,
  `money-exponents.json`, and so on.
- **35 endpoint declarations** in `Networking/Endpoint.swift`.
- `FixtureCorpusTests`, which extracts every `/v1` literal from the source and requires each to be
  claimed by a fixture — so the corpus cannot silently fall behind the client.

Two consequences, and they are the whole reason this plan is shaped the way it is.

**The contract is not up for negotiation, and not up for invention.** Every payload shape is already
decided and already decoded by working Swift. Where this plan says "build `GET /v1/screens/home`", the
acceptance criterion is not prose — it is `home-inr.json`.

**The server owns formatting, not just calculation.** The fixtures carry pre-rendered strings:

```json
{ "minor": 553900, "currency": "INR", "exponent": 2, "display": "₹5,539" }
"shareOfPayLabel": "9% of pay"
"percentageLabel": "177% of goal"
"verdict": "met"
```

iOS ADR-0003 removed the client's formatter entirely, and ADR-0027 made a *blank* `display` string a
decode failure. So the rounding ladder, symbol spacing, percentage labels, verdicts, and the
"Today / Yesterday / N days ago" date labels are all server deliverables, and all testable.

### 1.1 The contract harness — the engine of this plan

Slice 0 copies the corpus into `test/contract/` and generates **one failing test per endpoint**.
Each asserts that a live response satisfies the fixture's shape: same keys, same types, same
`display` formatting rules, same enum values.

Every slice below is then defined by which of those tests it turns green. That gives a definition of
done that cannot be argued with, and it makes client/server drift a build failure rather than a bug
report.

Two rules keep it honest:

- **Shape and formatting are asserted; figures are not.** A fixture's `553900` is one user's data. The
  test asserts `minor` is an integer, `display` matches the ladder, and `share` sums to 1 — not the
  literal value.
- **The corpus is copied, with its commit recorded, not imported across repos.** A cross-repo path
  breaks CI. A drift-check script re-copies and fails if anything changed, so an iOS-side contract
  change surfaces as a red backend build.

---

## 2. Delivery: slice by slice, deployed from day one

**This is the recommendation you asked me to make.** Nine vertical slices. Each ends with real
endpoints, live on staging, and named fixtures green.

**Deploy in slice 0, before any feature exists.** Two reasons that decide it:

- Deployment problems — secrets, TLS, CORS, connection limits, cold starts — cost hours on day one
  and days on day thirty, and day thirty is when you are trying to ship.
- The iOS app currently runs on fixtures. A live staging URL lets it move onto real endpoints **one
  screen at a time**, which is when contract mismatches are cheap to fix.

Not one shot. A single big-bang integration would land every unknown simultaneously — auth, money
formatting, timezone boundaries, rollover, deployment — with no way to tell which one broke the
screen.

---

## 3. Runtime: Node

Decided 13 August 2026. This reverts `DEVELOPMENT_PLAN.md` §1.1, which moved the backend to
Cloudflare Workers.

### 3.1 Why the reversal holds up

The Workers decision rested on "the native Mongo driver now works on Workers", which is true — I
verified it under `wrangler dev`. But *possible* was doing the work of *appropriate*. Five costs have
since become concrete:

| Workers cost | On Node |
|---|---|
| `@cloudflare/vitest-pool-workers` **cannot load the `mongodb` driver** — verified 12 Aug; the driver's `lib/bson.js` imports itself through workerd's path-based module registry. ADR-0014's integration tests are blocked with no config-level fix | non-issue |
| `GET /v1/content/curriculum/pdf` — the client already links to a **server-generated PDF** (iOS ADR-0019). No practical PDF path on Workers | ordinary library |
| WASM argon2id in a CPU-limited isolate — unproven; issue #3 exists solely to time it | native `argon2`, no ceiling |
| Ephemeral isolates against Atlas's connection ceiling — the **#1 risk** in `DEVELOPMENT_PLAN.md` §8, with a Durable Object broker as the escalation | one long-lived pool; risk disappears |
| Cron handlers capped at 10 ms CPU, forcing cron→queue fan-out for all four jobs | ordinary scheduler; per-user fan-out kept where it earns its place |

### 3.2 Stack

| Concern | Choice | Note |
|---|---|---|
| Runtime | **Node 22 LTS**, TypeScript `strict` | |
| HTTP | **Hono, on `@hono/node-server`** | Keeps `src/index.ts`, the routes, and the error envelope exactly as written. Also keeps the door open to Workers later — the same route code runs on both |
| Database | native `mongodb` driver ≥ 6.15.0 | unchanged |
| Validation | zod, types inferred | unchanged |
| Password hashing | **`argon2`** (native), m=19 MiB / t=2 / p=1, env-tunable | replaces `hash-wasm` |
| JWT | `jose` | keep — works on Node, no reason to churn |
| Logging | pino, JSON to stdout | replaces bespoke `console.error` JSON |
| Errors | `@sentry/node` | replaces `@sentry/cloudflare` |
| Scheduling | in-process scheduler for `fx:refresh`, `streak:remind`, `purge:deleted`; **per-user fan-out retained for `month:rollover`** | the fan-out was never really about CPU limits — it is what gives per-user retries on the most dangerous job |
| Tests | vitest, plain Node environment | drops `@cloudflare/vitest-pool-workers` and its blocker |

**Keeping Hono is the single highest-leverage choice here.** It makes the runtime switch a change of
adapter and dependencies — roughly half a day — rather than a rewrite of everything already built.

### 3.3 What is superseded

| ADR | Fate |
|---|---|
| 0001 money-representation · 0002 invariant enforcement · 0003 budget outputs | **stand unchanged.** ADR-0002's `no-restricted-imports` gate is already live |
| 0004 identity · 0005 session lifecycle | **stand**; hashing primitive changes from WASM to native argon2 |
| 0006 month filing · 0009 learn grading · 0011 idempotency · 0012 events · 0013 operational endpoints | **stand unchanged** |
| 0008 content delivery | **amended** — content stays static, versioned, ETag'd, no database. Served from disk rather than a Worker bundle. The reasoning survives; the mechanism changes |
| 0010 auth throttling | **amended** — per-account lockout stands as the primary mechanism; the Workers rate-limiting binding becomes an app-level limiter, with Cloudflare WAF still defence in depth |
| 0007 scheduled jobs | **superseded** — needs a replacement ADR for the Node scheduler, keeping per-user fan-out for rollover |
| 0014 test database strategy | **stands, and now actually works** — the per-run `hisaabwise_test_<runId>` database with both guards was blocked by the vitest pool; on Node it is straightforward |
| 0015 phase-zero gate split | **moot** — it existed only because Cloudflare credentials were missing |

To delete: `wrangler.toml`, `worker-configuration.d.ts`, the `@cloudflare/*` and `wrangler`
dependencies, and the `vitest.config.ts` workaround. To keep: `src/db.ts` (the connection discipline
and fail-fast are still right, minus the dynamic import), `src/routes/health.ts`, `docs/api.md`,
`eslint.config.mjs` including the ADR-0002 gate, `CONTEXT.md`, and every surviving ADR.

---

## 4. The nine slices

### Slice 0 — Spine

No features. A deployed service that answers, connected to Atlas, with the harness that defines
everything after it.

- Node + Hono + TypeScript `strict`; lint, typecheck, test all green
- `GET /health` (no database access) and `GET /health/db` — both already written and tested
- `src/db.ts` on a long-lived pool; the two-database split; fail-fast on a missing URI
- Error envelope `{error:{code,message}}`; request logging; Sentry
- **Contract harness**: corpus copied to `test/contract/`, one failing test per endpoint, drift check
- GitHub Actions: `release` → staging, `main` → production
- **Deployed staging URL, health check green**

**Done when:** the iOS app's configurable base URL points at staging and `/health` answers over
HTTPS; every contract test exists and is red for a documented reason.

### Slice 1 — Content and reference data

First because it needs no authentication and no other slice.

| | |
|---|---|
| **Endpoints** | `/v1/content/tips` · `/articles` · `/articles/:id` · `/curriculum` · `/content/picklists` · `/content/reference/countries` · `/reference/currencies` · `/content/security-questions` |
| **Fixtures** | `tips.json` `curriculum.json` `article-scams.json` `picklists.json` `reference-countries.json` `reference-currencies.json` `reference-security-questions.json` |
| **Data** | extraction from `HisaabwiseDesigns/HisaabWise 6.html` into `content/` |

Counts are the test, asserted exactly: **49** tips with `{c}` tokens verbatim · **3** articles ·
**5** units / **15** lessons / **124** steps = **58** teach + **66** question · **50** single-choice +
**14** numeric + **2** multi-select · **251** countries · **160** currencies · **87** languages ·
**22** transport + **20** other · **14** security questions with stable `sq01`…`sq14` ids. The
`?demo` block is not extracted, and its absence is grepped.

**Done when:** the client's Learn tab, tip of the day, article reader, and every picker render from
the server. ETag revalidation works.

### Slice 2 — Identity

Gates every screen below it, so it comes before any screen.

| | |
|---|---|
| **Collections** | `users` `refresh_tokens` `password_resets` |
| **Endpoints** | `POST /auth/register` (atomic, all three steps in one call) · `login` · `refresh` · `logout` · `logout-all` · `forgot-password/questions` · `forgot-password/verify` · `reset-password` · `GET/PATCH /v1/me` · `PUT /me/currency` · `/me/language` · `/me/timezone` · `POST /me/password` |
| **Fixtures** | `session-tokens.json` `me-verified.json` `me-unverified.json` `logout-acknowledged.json` `language-english.json` `language-arabic.json` |

Carries: refresh rotation with **family revocation on reuse of a revoked token**; the `sec` claim
against `securityEpoch` so a password change invalidates access tokens immediately; per-account
lockout that an IP limiter structurally cannot do; identical body **and timing** for a non-existent
email; security answers hashed over the **normalised** form, never raw.

#### 4.2.1 Recovery is by security question — no email, no SMS *(decided 13 Aug 2026)*

Nothing is verified out of band. Registration collects email, phone and DOB and verifies none of
them, so **the two security answers are the entire account-recovery mechanism**.

The flow is three steps, mirroring the in-session password change the client already implements
(`currentPassword → securityQuestions → newPassword`):

1. `POST /v1/auth/forgot-password/questions` — email in, **the user's two question ids** out. Returns
   two plausible question ids for an unknown email as well, at matching timing, so it is not an
   enumeration oracle.
2. `POST /v1/auth/forgot-password/verify` — email + both answers + DOB. On success issues a
   **single-use, short-lived reset ticket**; never reveals which answer failed.
3. `POST /v1/auth/reset-password` — ticket + new password. Revokes every refresh-token family and
   increments `securityEpoch`.

`password_resets` survives as the store for those tickets rather than for emailed tokens.
`email_verifications` is **dropped — nine collections, not ten.** `verify-email` and
`resend-verification` are removed from the contract.

**Two consequences you should decide about with your eyes open, then I will build it as specified.**

**There is no path back for a user who misremembers an answer.** Answers are hashed over the
normalised form and compared exactly — Levenshtein tolerance was deliberately dropped (it cannot be
computed against a hash), so `Jaipur` against a stored `Jodhpur` fails, as intended. With email reset
gone there is no second route, and because `DELETE /v1/me` needs a session, a locked-out user cannot
exercise their PDPL erasure right either. That is a compliance gap, not only a support one. Worth
pairing with an owned manual process before launch.

**Two low-entropy answers are the whole of takeover defence** on an app holding salary and spending
data, and the unverified email is not even a channel for warning the real owner. Mitigations, all
built in and none of them costing UX: hard per-account lockout on step 2 (ADR-0010's mechanism
already covers it), both answers required, no indication of which failed, identical timing, single-use
tickets, and a logged alert on every successful reset.

**One cheap addition I would recommend:** require **DOB** alongside the two answers, as written above.
It is already collected for the 13+ gate, it costs the user one field on a screen that does not exist
yet, and it meaningfully raises the bar on a mechanism that is now load-bearing. Say the word and I
will drop it.

#### 4.2.2 `emailVerified` stays in the contract, always `true`

The client already threads `emailVerified` through `Session`, `AccountScreen`, `AccountView` and
`AppShell`'s unverified banner — roughly 50 references plus `me-unverified.json` and
`account-unverified.json`. Removing the concept would mean an iOS change and a fixture-corpus change
for no functional gain.

So the field stays and the server sets it at registration. The banner never fires, the two fixtures
remain valid shapes, and **no iOS work is needed**. If verification is ever wanted, the field is
already there to carry it.

**Done when:** register → login → refresh → logout works from the app; forgot-password recovers an
account end to end; a password change kills another device's session; three failed logins from three
IPs still lock the account; an unknown email is indistinguishable from a wrong password in body and
timing.

### Slice 3 — Money domain and Home

The first screen, and the slice that decides how every figure in the app looks.

| | |
|---|---|
| **Domain** | `money.ts` — pivot conversion through USD, the magnitude rounding ladder, symbol spacing, `display` strings, `{c}` resolution. `budget.ts` — both 50/30/20 branches, `saved` `net` `overspent` `surplus` `verdict`. `time.ts` — day keys and month keys in the stored timezone |
| **Endpoints** | `GET /v1/screens/home` · `/v1/budget` · `/v1/fx/rates` |
| **Fixtures** | `home-inr.json` `home-first-run.json` `budget-inr.json` `budget-aed.json` `budget-drifted.json` `money-exponents.json` |

FX can start from a seeded static rate set so this slice is not blocked on provider procurement; the
live feed lands in slice 8.

**Done when:** Home renders from one request with no client-side arithmetic; `budget-drifted.json`'s
blank-`display` case is refused; the D1 regression holds — an INR salary shows identically everywhere
and "% of pay" is computed against it.

### Slice 4 — Expenses

| | |
|---|---|
| **Collections** | `expense_entries` `fixed_costs` |
| **Endpoints** | `GET /v1/screens/expenses` · `POST /v1/expenses` · `DELETE /v1/expenses/:id` · `GET/PUT /v1/expenses/fixed` · `/expenses/fixed/:categoryId` · `/expenses/lines` · `/expenses/lines/:categoryId` |
| **Fixtures** | `expenses-inr.json` `expenses-first-run.json` `expenses-over-budget.json` |

Writes return the updated screen payload, so the client never patches its own copy. The
client-supplied UUID `_id` **is** the idempotency mechanism — a duplicate insert is `E11000` →
"already recorded". `monthKey` is server-derived from `entryDate` in the user's timezone and frozen.
Writes into a closed month are rejected `MONTH_CLOSED`.

**Done when:** logging and deleting entries updates every figure on both Home and Expenses from
server truth; date labels come from the server; a replayed create does not double-count.

### Slice 5 — Learn

| | |
|---|---|
| **Collections** | `learn_progress` |
| **Endpoints** | `GET /v1/screens/learn` · `GET/POST /v1/learn/progress` · `POST /v1/learn/lessons/:id/complete` · `GET /v1/content/curriculum/pdf` |
| **Fixtures** | `learn-first-run.json` `learn-in-progress.json` `learn-complete.json` `lesson-completed.json` `lesson-revisited.json` |

The server recomputes XP from its own answer keys and rejects impossible submissions: question ids
must be exactly the lesson's set, in order, no duplicates, no unknowns; wrong answers ≤ 3; a run that
exhausted its hearts cannot claim completion; **XP is granted on first completion only**; sequential
unlocking enforced; numeric tolerance strictly `< 0.5`. Streak is evaluated lazily against the stored
timezone, so a device-clock change cannot move it.

The **curriculum PDF** is a real deliverable here — it is what the user takes away offline (iOS
ADR-0019), and nothing has scoped it yet.

**Done when:** a forged high-XP submission is rejected; replaying a lesson earns nothing; the streak
survives reinstall and ignores the device clock; the PDF downloads.

### Slice 6 — Reports and month rollover

The most dangerous code in the system.

| | |
|---|---|
| **Collections** | `month_archives` with the **unique `(userId, monthKey)` index** as the idempotency backbone |
| **Endpoints** | `GET /v1/screens/reports` · `GET /v1/screens/reports/:monthKey` · `GET /v1/fx/rates/:yyyy-mm` |
| **Fixtures** | `reports-inr.json` `reports-two-years.json` `reports-empty.json` `reports-month-inr.json` `reports-month-aed.json` `reports-month-quiet.json` |
| **Job** | `month:rollover`, every 15 minutes, per-user fan-out |

Selection is **catch-up-safe** — `localMonthBoundaryPassed AND no archive doc for (userId, monthKey)`,
never "crossed in the last hour". Fifteen minutes rather than hourly because Asia/Kolkata is +5:30
and Asia/Kathmandu +5:45, both squarely in the target market. Archives are immutable and carry a
pinned `fxRateSetId`. The live month is `max(currentLocalMonth, latestArchived + 1)` and never moves
backwards.

Also needs a **seed script** for the Feb–Jul 2026 archive months, guarded to refuse a production URI,
or Reports has nothing to render in dev.

**Done when the full staging suite passes** — and this is a hard gate on every `main` merge touching
the job: archive holds salary, goal, saved and full payload; live month cleared; rent and utility
lines carried forward; **run twice → second writes nothing**; **skip a run then run late → the missed
user is still archived**; a retry mid-write does not double-write; changing display currency converts
figures but never changes a goal-hit verdict.

### Slice 7 — Account and compliance

| | |
|---|---|
| **Endpoints** | `GET /v1/screens/account` · `GET /v1/me/export` · `DELETE /v1/me` · `POST /v1/events` |
| **Fixtures** | `account-inr.json` `account-aed.json` `account-unverified.json` `me-export.json` |
| **Job** | `purge:deleted`, daily |

Export streams JSON built from cursors, never materialised in memory; CSV is served per part
(`?format=csv&part=expenses|archives|learn|events`). Deletion is soft with a 30-day grace, then hard
erase across every collection leaving only a tombstone; the email stays reserved during grace and is
released on purge. Events are bounded by a name allowlist with declared prop keys.

**Done when:** deletion blocks sign-in, and after purge no user data remains in any collection;
export returns everything; `POST /v1/events` is live so activation metrics are never backfilled.

### Slice 8 — Ship

FX provider live (`fx:refresh` writes a dated doc with all 160 codes; an incomplete set writes
nothing and alerts; never a hardcoded fallback) · `streak:remind` + APNs · Sentry dashboards and
alert routing · rate limiting and WAF · **Arabic content** · Cloudflare cache rules plus the
cache-leak check (two users, `curl /v1/me` with each token → different bodies, `BYPASS|DYNAMIC` on
both) · **restore an Atlas backup into a scratch cluster once**.

---

## 5. Credentials and data — act on these now

**Rotate the Atlas password.** The connection string for `makinananya_db_user` was pasted into a chat
transcript. Rotate it in Atlas, then put the new value only in `.dev.vars` (gitignored) and the host's
secret store. It is not written to any file in either repo.

**The URI names no database.** It ends at `mongodb.net/`, so the driver silently falls back to a
database called `test`. It needs an explicit path — `/hisaabwise_dev`.

**Two databases, not one.** Rule 4 requires dev/staging and production separated, so that no local
run or test can reach real user data. Both live in the existing cluster.

**Confirm the cluster has continuous backup.** An M0 has none. This must be settled before slice 2
stores a real account, because that is the first moment losing the database costs a user something.

---

## 6. Hosting — the one thing still open

You said "servers will be in Cloudflare". Cloudflare has no classic Node-server product, so with Node
chosen there are two honest readings, and slice 0 is written host-agnostic (Dockerfile plus a
documented env contract) so this can be settled late without rework.

**A — Cloudflare Containers.** Genuinely Cloudflare-hosted Node. Up to 4 vCPU / 12 GiB, billed per
10 ms of active use on the $5/mo Workers Paid plan. Costs: a Worker front door is mandatory
(containers accept no direct inbound TCP), **cold starts are 1–3 s** after sleep unless `sleepAfter`
keeps instances warm, and the filesystem is ephemeral. Cloudflare's own docs say it is not a
drop-in replacement for an always-on PaaS where predictable monthly spend matters.

**B — Cloudflare in front, compute on a normal PaaS** (Render/Railway/Fly). Exactly what Technical
Spec §8 planned: `CNAME api` → host, proxy on, TLS Full (strict), WAF on `/v1/auth/*`, cache rules
per §8.1. Cloudflare still owns DNS, TLS, CDN, WAF and caching — it is the public face — while the
Node process stays genuinely long-lived.

**My recommendation: B.** Choosing Node was largely about wanting one warm process with a real
connection pool; option A reintroduces sleep and cold starts, which is most of what we were escaping.
B also keeps every Cloudflare capability the invariants depend on. If single-vendor billing matters
more than a 1–3 s worst-case app-open, A is defensible — and because slice 0 ships a Dockerfile,
moving A↔B later is a deploy change, not a rewrite.

---

## 7. External dependencies, by lead time

Start the top three now; they gate slices you will otherwise reach and stall on.

| Item | Gates | Lead time |
|---|---|---|
| ~~**Email provider + domain verification**~~ | **Off the critical path** as of 13 Aug 2026 — nothing is verified by email and recovery is by security question (§4.2.1), so slice 2 no longer needs a mail provider. Still wanted eventually for reset alerts; no longer blocking | — |
| **FX provider**, commercial terms, 160 currencies | slice 3 conversion, slice 6 pinned sets. Free tiers are non-commercial or ~30 currencies. **Now the longest external lead item** | account, possibly paid |
| **Domain registration** — `hisaabwise.com` proposed (§9.1) | TLS, the marketing site, and the hosted Terms/Privacy the consent checkbox links to | minutes to register, ~1 day DNS |
| **Terms + Privacy authored and reviewed** | the registration consent checkbox that already exists in the client; App Store submission | weeks — legal, not hosting |
| **Arabic translation** — 49 tips, 3 articles, 124 steps | slice 8. `language-arabic.json` is already in the corpus but only `.en.json` is planned. **Assumption: English first, plumbing in place, Arabic before submission** | unscoped |
| APNs `.p8` key | slice 8 streak reminder | minutes, once enrolled |
| Sentry projects | slice 0 | minutes |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Rollover corrupts immutable history** — the most dangerous job | unique `(userId, monthKey)`; catch-up-safe selection; per-user fan-out; the idempotency + skipped-run + retry suite as a `main` gate |
| **Content extraction is silently lossy** — the content is the moat | exact count assertions in CI, decomposed (58 teach + 66 question, not just 124); spot-diff against the design |
| **Server-side formatting drifts from the design** — every figure now comes from the server | the fixtures encode it; the contract harness asserts the ladder and symbol spacing |
| **Client/server contract drift** | corpus copied with its commit recorded; a drift check fails the build |
| **Atlas connection exhaustion** | largely resolved by choosing Node; still monitor connection metrics from slice 2 |
| **Timezone correctness** — day keys, month keys, streaks, rollover all depend on the stored IANA zone | one `time.ts`, tested at whole-hour, half-hour and quarter-hour offsets; never UTC, never the device clock |
| **Cache HIT on per-user data is a breach, not a win** | bypass list per invariant 8; the two-user check in slice 8 |

---

## 9. Decisions — resolved and open

### 9.1 Resolved 13 August 2026

O1, O2 and O3 are closed. `DEVELOPMENT_PLAN.md` §7 should be updated to match, and the
`// TODO(decision)` markers can come out of the code rather than being carried.

| # | Item | Resolution |
|---|---|---|
| **O1** | Does Additional Income lift the wants allowance, or route to savings? | **Lifts the allowances.** `income = salary + additionalIncome`, and 50/30/20 runs against that income — so needs, wants and savings allowances all rise. This is the prototype's own behaviour, so no screen changes meaning. *(Read from your "yes" — flag it if you meant route-to-savings, because it changes every allowance in the app.)* |
| **O2** | Verify phone by SMS OTP, or drop the field? | **Collect, do not verify, do not rely on it.** No OTP, no SMS provider |
| **O3** | App lock (Face ID / passcode)? | **Not at launch.** Screens stay free of secrets in the app-switcher snapshot |
| — | Email verification | **Dropped.** `emailVerified` stays in the contract, always `true` (§4.2.2) |
| — | Password recovery | **Security questions + DOB**, no email link (§4.2.1) |

**API domain — proposed: `hisaabwise.com`.**

| Host | Purpose |
|---|---|
| `api.hisaabwise.com` | production API |
| `api-staging.hisaabwise.com` | staging API |
| `hisaabwise.com` | marketing site, plus the hosted **Terms** and **Privacy Policy** the registration consent checkbox links to |

Reasoning: the apex is needed anyway for the legal pages, so one registration covers API, staging and
marketing. `.com` is the safe default for an app serving expatriates in the UAE who may be reading in
several countries.

Two alternatives worth knowing about. **`hisaabwise.app`** is HSTS-preloaded at the TLD, so browsers
refuse plain HTTP outright — a small, free security win that reads well for a finance app; take it if
the `.com` is gone. **`hisaabwise.ae`** signals the market best but `.ae` registration generally
requires a UAE presence, so it is a business-setup question rather than a technical one, and it can be
added later as a redirect. Check availability before committing — I have not verified it.

### 9.2 Still open

| # | Item | Default in effect |
|---|---|---|
| Hosting | Cloudflare Containers vs Cloudflare-in-front (§6) | B, pending your confirmation |
| — | Node scheduler mechanism (replacing ADR-0007) | in-process, decided in slice 0 |
| — | Arabic translation timing | English first, plumbing in place, Arabic before submission |
| — | Manual recovery process for a user locked out of their own account (§4.2.1) | none — needs an owner before launch |

### 9.3 ADRs this raises

To be written alongside the slices they govern, so the reasoning is on the record rather than in this
plan only:

- **Node runtime and the Hono adapter** — supersedes the `DEVELOPMENT_PLAN.md` §1.1 table
- **Scheduling on Node** — supersedes ADR-0007, retaining per-user fan-out for `month:rollover`
- **Recovery by security question** — amends ADR-0004 and ADR-0010; records the two risks in §4.2.1
  and what was accepted
- **Screen-scoped contract testing against the iOS corpus** — the harness in §1.1
