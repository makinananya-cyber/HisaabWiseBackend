# End-to-end test report — 14 August 2026

Live run of the iOS app in the simulator against the real backend and the real dev/staging Atlas
database. No fixtures, no mocks.

## What was run

| | |
|---|---|
| Backend | `npm run dev` → Hono on Node, `localhost:8080`, real MongoDB Atlas (dev/staging) |
| Client | `HisaabWise.app`, Debug configuration (`HW_API_BASE_URL = http://localhost:8080`) |
| Device | iPhone 17 simulator, 402×874 pt |
| Build | `xcodebuild build -scheme HisaabWise -configuration Debug` → **BUILD SUCCEEDED** |
| Boot | content loaded (`en`), Atlas connected, **17 indexes ensured**, both jobs scheduled |
| Traffic | 98 requests observed: `200`×70 · `201`×4 · `304`×14 · `401`×1 · `422`×9 |

**Verdict:** the backend is in good shape — every screen endpoint returned real, internally
consistent data, and the money, budget, and session invariants held under live testing. The gap is
on the client: **three blockers**, one of which means a new user cannot actually create an account
through the UI.

---

## Blockers

### B1 — Registration cannot be completed. The second security-answer field never takes focus

The highest-severity finding. On registration step 2, the "Your answer" field belonging to
**question 2** cannot be focused. Tapping it does nothing: the caret stays in answer 1 and further
keystrokes append there (answer 1 accumulated all three attempts' text).

- Tried 4 times, at `x` = 201 and 300, `y` = 731, 786 (field spans ≈709–757 pt), and after scrolling
  the field to mid-screen.
- Taps **do** reach that region: a tap at `y=634` opened the question-2 picker sheet.
- Validation correctly refuses to continue — *"Please answer your second question."* — so the user
  is hard-stopped with no way to satisfy it.

Not a general component fault: the password-change screen has the same two-identical-`HWTextField`
pattern and both fields focus normally. It is specific to
[RegistrationMoneyStep.swift:149](../HisaabWiseIOS/HisaabWise/HisaabWise/Views/Registration/RegistrationMoneyStep.swift).

Leads, not conclusions — I did not find the cause:
- Both answer fields pass the **same** localisation key, `registration.two.answer.label`
  ([lines 122 and 151](../HisaabWiseIOS/HisaabWise/HisaabWise/Views/Registration/RegistrationMoneyStep.swift)).
- `HWTextField` applies `.id(true)` to the inner non-secure `TextField`, so both answer fields carry
  an identical explicit id ([HWTextField.swift:207](../HisaabWiseIOS/HisaabWise/HisaabWise/Components/HWTextField.swift)).
- Ruled out: `@FocusState` is per-instance, and `hwEnters` only applies `opacity`/`offset`, both of
  which move hit-testing with the view.

I completed registration through `POST /v1/auth/register` to continue the run.

### B2 — No in-app account deletion (App Store 5.1.1(v))

The Account screen offers Personal Information, Language, Currency, Password, Download my data and
Log out — and nothing else. `DELETE /v1/me` is implemented and working server-side, but a
repo-wide grep of `Views/`, `ViewModels/` and `Networking/` finds no reference to account deletion
at all. An app that lets users create an account must let them delete it in-app; this fails review
as it stands.

### B3 — Forgot password is a placeholder

"Forgot password?" on the sign-in screen leads to a screen reading **"This screen is not built
yet."** A user who forgets their password has no recovery path, while three backend routes sit
finished behind it.

---

## Bugs

### C1 — The 13+ date picker is a day stricter than the server

Opening the date-of-birth sheet on 14 Aug 2026 shows **14 Aug 2013 ringed as the selectable
maximum** and greys out 15 Aug onward. But tapping 14 Aug does nothing — the field stays on its
placeholder. 13 Aug selects fine.

The server disagrees with the client, and the client is wrong:

| Date of birth | Server |
|---|---|
| 2013-08-15 | `422 UNDER_AGE` |
| **2013-08-14** (turns 13 today) | **`201` — accepted** |
| 2013-08-13 | `201` — accepted |

So someone whose 13th birthday is today is accepted by the API and silently refused by the picker,
which also *advertises* that date as available. Either make the boundary inclusive on the client or
grey out 14 Aug too — but the ring on an unselectable date is wrong either way.

*(An earlier read of mine that the server also refused exactly-13 was wrong — it came from a
malformed `phone` field in my request, not the age gate.)*

### C2 — Arabic is selectable but not translated

Choosing العربية applies RTL correctly — text right-aligns, rows mirror, the tab bar reverses to
Account · Reports · Learn · Expenses · Home, the back chevron flips, "Add Expense +" puts the glyph
on the right. **Every string stays in English.** The layout work is done; the translations do not
exist. Shipping a language picker with an untranslated locale is worse than not offering it.

Related: the Language row renders the value as "Arabic" in English rather than "العربية", and
`content/` holds only `*.en.json`.

### C3 — Blank screen with a bare warning icon after any language change

Immediately after switching language the current screen renders empty except for a small ⚠️ — no
title, no message, no retry. Reproduced in both directions (en→ar and ar→en). It recovers as soon
as you navigate away and back.

The API is not at fault: every screen request after the change returned `200`. This is the failure
state rendering without its copy, which also contradicts the documented `StateView` contract that
an error code always becomes copy in one place.

### C4 — Amount fields append to a pre-filled `0`

Editing rent: the field arrives pre-filled with `0`, and typing `4500` produces **`04500`**. It
parsed to AED 4,500 so nothing was corrupted, but every user editing a zero-valued amount sees
this. Clear the field when the value is zero, or select-all on focus.

### C5 — The phone number field accepts letters

A 14-character alphanumeric string typed into the phone field was accepted verbatim, giving
`501234567` followed by all of those letters and digits. No numeric keyboard restriction and no
input filtering. The server's
`phoneSchema` requires `^\d{4,15}$`, so this is caught eventually — but only after the user has
filled the rest of the form.

### C6 — Personal Information serves a stale salary

After changing salary from AED 12,000 to 20,000, Home immediately showed "24% of pay" (correct for
20,000) while Personal Information still read **AED 12,000**. Navigating away and back showed
20,000. The screen does not re-fetch when it reappears, so two screens can disagree about salary —
the exact class of inconsistency the D1 gate exists to prevent.

### C7 — The savings goal is not re-derived when salary changes

The goal is set at registration as 20% of salary and then never revisited. After salary went
12,000 → 20,000 the goal stayed **AED 2,400** — now 12% of pay — and the badge inflated to
**"635% of goal"**. Either re-derive it, or prompt, or stop presenting a stale goal as a
percentage.

This is the same root cause as the known first-run **"500% of goal"** (ADR-0019 §2), which I
reproduced live: a brand-new account with nothing logged reads *"You have saved AED 12,000 — your
whole goal, and a little more."* `saved` is unspent salary, not deliberate saving, and at
month-start that reads as nonsense.

### C8 — Lessons do not resume

Leaving a lesson part-way saves progress — the map node draws a partial ring — but re-entering
**restarts from step 1**. The node badge also still reads "START" rather than something like
"CONTINUE". Combined with C9 below, an interrupted user loses their place entirely.

### C9 — One unexplained exit from the lesson player

Once, the player dropped back to the Learn map at a teach→question transition. **Not
reproducible** — I repeated the same 4 steps and the question step rendered correctly, and the
lesson then completed normally. Recording it because it happened, not as a confirmed defect.

### C10 — `PUT /v1/me` deletes fields you omit

My update sent only `displayName` and `salary`; the stored phone number was silently wiped
("Not given"). That is defensible `PUT` semantics and the iOS edit screen sends every field, so
users are not affected today — but there is no guard, and one client omitting one field
permanently destroys data.

### C11 — Category percentages can sum to 101%

On the seeded account Home listed 50 + 14 + 16 + 9 + 5 + 7 = **101%**. The new account summed to
exactly 100 (95 + 5), so this is per-rounding rather than always wrong. Worth a largest-remainder
adjustment so the column always totals 100.

### C12 — Copy and content

- **"Your streak just grew to 1 days."** — plural not handled on the completion screen.
- **"A AED 15 coffee four times a week…"** — the article's indefinite article does not agree with
  the injected currency token.
- A lesson step is framed as *"an example from a country that **does** have income tax"* while the
  amounts render as **AED** (and as **₹** once display currency changed) — the framing and the
  currency contradict each other. The `{c}` token makes the figures currency-agnostic, which is
  right in general and wrong for this specific hypothetical.

### C13 — Smaller UX observations

- The **logout confirmation** popover offers only "Log out" — no explicit Cancel; you dismiss by
  tapping outside.
- **Logout destination is inconsistent.** My first logout landed on Landing; the second landed on
  **Sign In with a back chevron**, i.e. the pre-login navigation stack was restored rather than
  reset. Documented behaviour is → Landing.
- The **date-of-birth sheet** has no Done button and does not dismiss when you pick a day.
- The **Reports empty state** replaces the whole screen including its "Reports" title, unlike every
  other screen.
- **Password reads "Changed just now"** on a brand-new account that has never changed its password.
- **"Get Started" goes to Sign In**, not registration; a genuinely new user has to notice the
  secondary "Create an account".
- **Download my data** took 11 s with no progress indicator, and no share sheet appeared —
  `GET /v1/me/export` returned `200`, so the request worked. The missing progress affordance is
  certain; whether the share sheet fails only in the simulator needs a device check.
- **Defaults are India-centric for a UAE product**: phone country defaults to **IN +91** and
  currency to **INR**. Deliberate for an expatriate audience, perhaps, but a UAE salary in AED is
  the overwhelmingly likely case and both defaults cost every user two extra pickers.

### C14 — Password change defers verification to the last step

Entering a **wrong** current password still advances through security questions and the new-password
form; the error only surfaces on final submit. The handling is then exactly right — it returns to
step 1, marks the field, shows *"That is not your current password."*, and **does not log the user
out** (the documented 422-never-401 rule held). But the user completes three steps before learning
step 1 was wrong.

---

## Operational findings

### O1 — `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in `.env`

The config layer prints its own warning: *"TLS certificate verification is OFF for all outbound
connections… Remove it unless you know exactly why it is there."* It should not be needed to reach
Atlas, and it disables verification process-wide. Worth removing and fixing whatever it was
papering over — the first connection attempt still timed out (`MongoServerSelectionError` after
10 s) before succeeding on retry, which suggests it never fixed the underlying problem.

### O2 — A stale server process served `INTERNAL` indefinitely

The dev server already running when I started returned
`{"error":{"code":"INTERNAL"}}` for `GET /v1/fx/rates`. A freshly started process served the same
route correctly. The likely cause is a dead Mongo pool that the process never recovered from —
worth a health check that fails when the pool is unusable, rather than serving `500`s forever.

### O3 — Latency is poor against remote Atlas

| median | p90 | max |
|---|---|---|
| 990 ms | 10.9 s | 21.7 s |

Slowest: `GET /v1/screens/home` 21.7 s · `POST /v1/auth/refresh` 15.3 s ·
`PUT /v1/expenses/fixed/rent` 14.3 s · `PUT /v1/me/language` 12.8 s.

This is almost certainly a local-machine-to-Atlas round trip rather than application code, and it
inflates everything above. But it is what a tester experiences today, and a 21-second Home load is
indistinguishable from a hang. Worth measuring again from a deployed environment before drawing
conclusions — and worth a skeleton/progress state either way.

---

## What works

Verified against live data, not assumed.

| Area | Evidence |
|---|---|
| Landing · strapline rotation | Rotated between launches |
| Sign in | Correct credentials → session; **unknown email and wrong password return byte-identical bodies** (`INVALID_CREDENTIALS`, `422`) |
| Registration (server) | `201` atomic create; `422 UNDER_AGE` at the boundary; zod issues logged, not returned |
| Session rotation | A `401` on `/v1/screens/account` was followed by one `/v1/auth/refresh` `200` and a successful retry — single-refresh-and-retry works |
| Home | Donut, "% of pay", categories, savings, tip, learn teaser, article teasers all live |
| Expenses | Summary, wants bar, **all 7 categories**, date labels |
| Add expense | AED 250.75 stored, displayed "AED 251" per the rounding ladder; totals propagated |
| Rent / fixed costs | Locked → Edit → saved AED 4,500 → re-locked |
| Budget engine | Wants allowance = 30% of pay exactly (AED 3,600 at 12,000; AED 6,000 at 20,000); groceries correctly counted as a need, not a want; the >50%-needs branch produced the right verdict sentence on the July report |
| D1 salary consistency | Salary 12,000 → 20,000 moved **every** derived figure coherently: 40%→24% of pay, saved 7,249→15,250, wants 3,600→6,000 |
| Money domain | AED→INR conversion correct (₹108,900 for AED 4,751 at the seeded rates); symbol spacing correct (`₹108,900` vs `AED 251`); ratios preserved across currencies |
| Learn map | Lock states derived; lesson 1 complete → lesson 2 unlocked, lesson 3 still locked |
| Lesson player | Teach steps, single-choice, **numeric** entry, hearts, per-question explanations |
| Lesson completion | +60 XP, 100% accuracy, streak 1, week strip, confetti — XP recomputed server-side |
| Reports | Six seeded months: trend bars with dashed goal line, hit/near/miss colouring, year grouping, avg spend, total saved |
| Month report | Totals, fixed/variable/extra-in, verdict sentence, donut at 93% of income, 6-category breakdown |
| Personal details | Username updated and persisted; **email locked with an explanation** (invariant 4) |
| Currency | Picker searchable, 160 entries, converts and re-renders everywhere |
| Language picker | Exactly the two shipped locales, EN checked |
| Password change | 3-step wizard; wrong current password → `422`, field error, **no logout**; correct flow succeeded — old password now `422`, new one `200` |
| Security questions | Question 2's list correctly omits the question used in question 1 |
| Export | `GET /v1/me/export` → `200` |
| Content | Curriculum served, ETag `304`s on revalidation, UAE-specific and well written |

---

## Not covered

- **Registration through the UI** — blocked by B1; the account was created via the API.
- **Arabic content correctness** — no Arabic strings exist to check (C2).
- **Month rollover and purge jobs** — scheduled at boot but neither fired during the run; the
  rollover suite remains the release gate.
- **Curriculum PDF**, article reader, `POST /v1/events` (still not called by the client), and
  account deletion (no UI).
- **Offline behaviour** and the `LoadState.offline` path.
- Whether the export **share sheet** presents on a real device.

## Test data created

In the shared dev/staging database, for cleanup when convenient:

- `rahul.verma.aug14@example.com` — the main test account (its password was changed during the
  password-change test; credentials are not recorded here), plus **6 seeded archive months**
  (Feb–Jul 2026) via `npm run seed:archives`, one expense, and rent.
- `age.2013-08-14@example.com` and `age.2013-08-13@example.com` — created by the age-boundary test.
- One expense entry and one `fixed_costs` document under the main account.

## Suggested order of work

1. **B1** — nothing else matters if people cannot sign up.
2. **B2** and **B3** — both are launch gates: one for App Store review, one because users lock
   themselves out of real financial data.
3. **C7 / first-run "500% of goal"** — the single most visible correctness-of-meaning problem, and
   still an open decision rather than a bug.
4. **C2** — either translate Arabic or remove it from the picker until it is ready.
5. **C1, C3, C4, C5, C6** — small, well-understood, and each one visible on first use.
6. **O1** — remove the TLS override and find out what it was hiding.
