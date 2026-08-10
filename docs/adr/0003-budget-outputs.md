# ADR-0003 — `saved` is the clamped residual; salary and goal are point-in-time

**Status:** accepted
**Supersedes:** Product Spec §4.2 (adds the missing `saved` definition), §3.3, §3.6
**Relates to:** workspace invariant 3, defects D1 and D6

## Context

Product Spec §3.3 says `saved` is "computed by the budget engine (income − needs − wants
spent, capped sensibly)" and §4.2 defines the allowances — but **§4.2 never defines `saved`
at all**, and "capped sensibly" is the entire question.

The prototype offers no guidance: `saved` is a **stored literal** (`saved: 1120` on Home,
one per archived month), never derived, never reconciled against the budget or the
transaction log. There is no reference implementation to match.

Three further gaps found in the prototype:

- **Two disagreeing threshold tables** for the same pill on the same number — Reports uses
  `≥100 hit / ≥70 near`, Home uses `≥80 / ≥45`. This is precisely the class of
  disagreement invariant 3 forbids.
- **`goalPct` divides by `goal` unguarded**, and the Account screen makes `goal = 0`
  reachable.
- **Nothing says which salary a mid-month raise applies to**, and `savingsGoal` is an
  absolute `Money`, so a goal set as 20% of AED 8,000 silently becomes 16% of AED 10,000.

## Decision

**`saved = max(0, income − needs − wantsSpent)`.**

Because all spending is either needs (rent, utilities, groceries) or wants (transport,
entertainment, other), the residual is the *only* quantity the server can derive — there is
no bank link and no savings-transfer ledger, so the app can never know what someone truly
set aside. The formula is effectively forced.

`GET /v1/budget` additionally returns:

- **`net`** — the same quantity unclamped, so an overspending user is told the truth.
- **`overspent: boolean`**.
- **`verdict`** — `hit` (≥100%) | `near` (≥70%) | `miss`, from **one** threshold table.
  Reports' table wins; Home's 80/45 is the outlier and, being more generous, is exactly the
  quiet disagreement that produced D1. The client never computes this.
- **`surplus`** — `max(0, saved − goal)`.

**The split bar keeps four segments** by splitting the residual at the goal:
`needs / wants / min(saved, goal) / surplus`. Under a residual definition of `saved`, the
prototype's `leftover = max(0, income − needs − used − saved)` is identically zero, so the
old fourth segment would vanish; this replacement is also more informative — "2,000 against
a 2,000 goal, plus 340 spare".

**Edge cases:** `goal = 0` → verdict `hit`, percentage reported as 100 (there is nothing to
miss). A negative goal is rejected at the API boundary.

**Salary and goal over time:** salary is a **point-in-time** value. The live month always
uses the current salary; the archive pins salary-at-close. No salary history, no proration —
that is real complexity for a rare event, and D1's fix is explicitly "one server-owned
salary that every screen reads", which proration would undermine. **The goal does not
auto-adjust** when salary changes; it is a figure the user owns, and silently moving
someone's savings target when they get a raise is worse than showing them the new
percentage. `goalWasSkipped` stays recorded so the population is identifiable if this is
ever revisited.

## Consequences

- A user who spends nothing "saves" 100% of income and always meets their goal. This is
  honest ("you did not spend it") but flattering. Accepted: the alternative — capping
  `saved` at `savingsAllowance` — makes a goal above 20% of pay mathematically unreachable,
  which is worse.
- `saved` is now derived everywhere, so Home, Expenses, and Reports cannot disagree. That
  is invariant 3 satisfied structurally rather than by discipline.
- Product Spec §4.2 must gain this formula. Its absence is why every prototype screen could
  hold a different number.
- Additional Income raises income and therefore all three allowances proportionally, which
  is open decision **O1**'s default. Implemented as such, marked `// TODO(decision): O1`.
  The prototype confirms this behaviour precisely, so the default is faithful.
