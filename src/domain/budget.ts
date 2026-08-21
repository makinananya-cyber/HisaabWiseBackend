import type { Money } from '../types/money';
import { clampToZero, fraction, isZero, percentage, subtract, sum } from './money';

/**
 * The adaptive 50/30/20 budget engine. **It exists exactly once** (invariant 3).
 *
 * Home, Expenses and Reports all read it, and `GET /v1/budget` is its only exposure point. That is not
 * tidiness: the prototype computed `saved` in three places and reached three different answers, and
 * carried **two disagreeing verdict tables** for the same pill on the same number — Reports at 100/70,
 * Home at 80/45. That quiet disagreement is defect D1's shape, and one implementation is the fix.
 *
 * Everything here is pure integer arithmetic on minor units in a single currency. Callers convert first
 * (`presentIn` in `money.ts`), and nothing here rounds for display — `saved` must not be a function of
 * how a figure was printed (defect D16).
 */

/** What the engine needs, all in one currency and all exact. */
export interface BudgetInput {
  /** `salary + additionalIncome`. Additional income **lifts the allowances** (O1 resolution). */
  readonly income: Money;
  /** rent + utilities + groceries. */
  readonly needs: Money;
  /** transport + entertainment + other. */
  readonly wantsSpent: Money;
  /** The user's absolute savings goal. It does not auto-adjust when salary changes. */
  readonly goal: Money;
  /**
   * The share of income the reader has chosen for wants, whole percent (`PUT /v1/me/budget/wants`), or
   * `null`/absent when they have not chosen one.
   *
   * **`null` reproduces the plain 50/30/20 exactly** — 30% wants, 20% savings, and an equal halving in the
   * adaptive branch — so a caller that passes nothing gets the behaviour this engine always had. A chosen
   * share `X` moves the middle figure at the expense of savings (Product Spec §4.2): needs stays the 50%
   * baseline, wants takes `X%`, savings takes `(50 − X)%`. In the adaptive branch, where needs have already
   * outgrown half of income, the same ratio splits what is left — so the reader's preference is honoured
   * rather than silently ignored when it matters most.
   */
  readonly wantsSharePercent?: number | null;
}

/**
 * The shares the wants sheet offers — **10% to 40% in fives** (Product Spec §4.2, mirrored by iOS
 * `WantsShare`). The floor is low enough for a reader remitting most of their pay home; the ceiling is what
 * leaves a savings share standing at all (40% wants against a 50% needs baseline still leaves a tenth).
 */
export const WANTS_SHARE_OPTIONS = [10, 15, 20, 25, 30, 35, 40] as const;

/** The default share when the reader has not chosen one — the 30 of 50/30/20. */
export const DEFAULT_WANTS_SHARE = 30;

/** Whether a percent is one the sheet offers, so the API refuses anything outside §4.2's bounds. */
export const isWantsShare = (percent: number): boolean =>
  (WANTS_SHARE_OPTIONS as readonly number[]).includes(percent);

/** `hit` ≥ 100% of goal, `near` ≥ 70%, `miss` otherwise. **One table, server-side.** */
export type Verdict = 'hit' | 'near' | 'miss';

/**
 * Home's savings meter names the same three states differently — `met`, `onTrack`, `low` — because it is
 * a meter rather than a pill. They are the *same thresholds*: Product Spec §4.2 settled the two
 * disagreeing tables at 100/70 and Reports' table won, so Home's more generous 80/45 is gone.
 */
export type MeterVerdict = 'met' | 'onTrack' | 'low';

export interface BudgetOutput {
  readonly income: Money;
  readonly needs: Money;
  readonly wantsSpent: Money;
  readonly wantsAllowance: Money;
  readonly savingsAllowance: Money;
  /** True when needs exceeded 50% of income, so the allowances came from the degradation branch. */
  readonly adapted: boolean;
  /** `max(0, income − needs − wantsSpent)`. **Derived, never stored, never entered.** */
  readonly saved: Money;
  /** The same figure unclamped, so it can be negative. What an overspending user is actually told. */
  readonly net: Money;
  readonly overspent: boolean;
  /** `max(0, saved − goal)`. The fourth segment of the split bar. */
  readonly surplus: Money;
  readonly verdict: Verdict;
  readonly goal: Money;
}

/**
 * Run the engine.
 *
 * **The split is needs, then wants, then whatever is left is savings** (Product Spec §4.2, reworked so the
 * reader's chosen share drives it):
 *
 * ```
 * available       = max(0, income − needs)          // what is left once essentials are paid
 * effective share = the reader's chosen %, clamped so savings still clears their goal (see effectiveWantsShare)
 * wantsAllowance  = min(share% of income, available) // never budget for wants you do not have
 * savingsAllowance = available − wantsAllowance      // the rest — the residual, not a flat 20%
 * ```
 *
 * So a reader with **no essential costs** and the 40% ceiling is shown **40% wants, 60% savings**; one whose
 * needs already take half their pay and who wants 40% is shown 40% wants and 10% savings — offered only while
 * that 10% still meets their goal. This is why `savingsAllowance` is a residual rather than a fixed fifth: the
 * old flat-20% (and the equal-halving degradation branch) ignored both the reader's preference and their goal.
 *
 * **Why `saved` is a residual too, and a *measurement* of the month rather than a plan.** There is no bank
 * link, so the app cannot know what was truly set aside; since all spending is either needs or wants, the
 * residual `income − needs − wantsSpent` is the only figure the server can honestly derive. It clamps at zero;
 * `net` carries the truth for someone who overspent. Note it uses wants **spent**, where `savingsAllowance`
 * uses the wants **allowance** — one is what happened, the other is the plan.
 *
 * `adapted` stays as an informational flag — needs have outgrown half of income — read by `/v1/budget` and the
 * fixtures; it no longer selects a different arithmetic.
 */
export function computeBudget(input: BudgetInput): BudgetOutput {
  const { income, needs, wantsSpent, goal } = input;

  const adapted = needs.minor * 2 > income.minor;

  const effective = effectiveWantsShare(income, needs, goal, input.wantsSharePercent ?? DEFAULT_WANTS_SHARE);
  const wantsAllowance = wantsAllowanceForShare(income, needs, effective);
  // The residual: everything left after essentials and the wants budget. `wantsAllowance` is already capped
  // at `available`, so this is never negative, but clamp defensively.
  const savingsAllowance = clampToZero(subtract(subtract(income, needs), wantsAllowance));

  const net = subtract(subtract(income, needs), wantsSpent);
  const saved = clampToZero(net);

  return {
    income,
    needs,
    wantsSpent,
    wantsAllowance,
    savingsAllowance,
    adapted,
    saved,
    net,
    overspent: net.minor < 0,
    surplus: clampToZero(subtract(saved, goal)),
    verdict: verdictFor(saved, goal),
    goal,
  };
}

/**
 * The one threshold table.
 *
 * **A goal of zero is `hit`**, and at 100% — there is nothing to miss (Product Spec §4.2). A negative
 * goal never reaches here; it is refused at the API boundary.
 *
 * **The threshold is applied to the *rounded* percentage — the same number the label prints.** So 99.9%
 * of a goal is `hit`, because the label beside the pill reads "100% of goal", and a pill saying "near"
 * next to a number saying 100% is exactly the disagreement defect D11 describes. Thresholding the exact
 * ratio instead would be more literally correct and would produce a screen that looks broken.
 */
/**
 * The savings goal a salary suggests — the **20** of 50/30/20.
 *
 * Registration's Submit and its "Skip for now" both send this figure, and until now that was the only
 * moment it was ever computed: a goal was authored once and then never revisited. So a reader whose pay
 * rose kept a goal measured against their old salary, and "% of goal" drifted past any useful reading —
 * 635% in one observed case, against a goal that had become 12% of what they now earned.
 *
 * **This suggests; it does not enforce.** A goal is the reader's to choose, and somebody deliberately
 * saving less than a fifth of their pay is not making a mistake the app should correct behind their back.
 * Callers offer the figure and let them take it.
 */
export const suggestedSavingsGoal = (salary: Money): Money => fraction(salary, 20, 100);

/** What is left of income once essential needs are paid — the pool wants and savings share. */
export const availableAfterNeeds = (income: Money, needs: Money): Money => clampToZero(subtract(income, needs));

/**
 * The wants allowance a given share would produce — the figure the Expenses sheet shows beside each
 * percentage, so the reader sees what "30%" actually means in their own money before choosing.
 *
 * `share%` of income, **capped at what is actually left after needs**: a reader whose rent already eats most
 * of their pay is never shown a wants budget larger than the money that exists. The same figure
 * `computeBudget` uses, so a previewed amount and the amount a write returns are the one number.
 */
export function wantsAllowanceForShare(income: Money, needs: Money, share: number): Money {
  const available = availableAfterNeeds(income, needs);
  const uncapped = fraction(income, share, 100);
  return uncapped.minor <= available.minor ? uncapped : available;
}

/** The savings a given share leaves once needs and that wants allowance are taken — the residual. */
export const savingsForShare = (income: Money, needs: Money, share: number): Money =>
  clampToZero(subtract(availableAfterNeeds(income, needs), wantsAllowanceForShare(income, needs, share)));

/**
 * Which of the offered shares the reader may actually pick — the ones that still leave enough to clear their
 * savings goal.
 *
 * A share is feasible when the savings it leaves (`income − needs − wants`) is at least the goal. Savings falls
 * as the wants share rises, so the feasible shares are always the run from the floor up to some ceiling — which
 * is why offering "up to 30%, not 40%" is a truthful thing to show rather than a scattered list.
 *
 * **Never empty.** When needs and the goal together already claim everything — so even the smallest wants share
 * would break the goal — the floor is offered anyway: the reader still needs *a* wants budget, and the one that
 * saves the most is the least-bad choice the app can give them.
 */
export function feasibleWantsShares(income: Money, needs: Money, goal: Money): number[] {
  const feasible = WANTS_SHARE_OPTIONS.filter(
    (share) => savingsForShare(income, needs, share).minor >= goal.minor,
  );
  return feasible.length > 0 ? feasible : [WANTS_SHARE_OPTIONS[0]];
}

/**
 * The share the engine actually applies — the reader's request, **clamped down to what keeps their goal
 * reachable**.
 *
 * The reader chooses from the feasible shares, but their essential spending grows through the month, so a share
 * that cleared the goal when they picked it can stop clearing it later. Rather than silently spend their savings
 * goal, the engine reduces the wants budget to the largest feasible share at or below what they asked for. A
 * request below the whole feasible run falls back to the floor — the app never hands out *more* wants than asked.
 */
export function effectiveWantsShare(income: Money, needs: Money, goal: Money, requested: number): number {
  const maxFeasible = Math.max(...feasibleWantsShares(income, needs, goal));
  return Math.min(requested, maxFeasible);
}

export function verdictFor(saved: Money, goal: Money): Verdict {
  if (isZero(goal)) return 'hit';
  const achieved = percentage(saved, goal);
  if (achieved >= 100) return 'hit';
  if (achieved >= 70) return 'near';
  return 'miss';
}

/** The same table, in the names Home's meter uses. */
export const meterVerdictFor = (saved: Money, goal: Money): MeterVerdict =>
  ({ hit: 'met', near: 'onTrack', miss: 'low' } as const)[verdictFor(saved, goal)];

/**
 * How full the savings meter is drawn, `0…1`.
 *
 * Clamped at 1: the meter is a progress bar and 177% of a goal is still a full bar. The *label* beside
 * it carries the real figure, which is why `home-inr.json` has `position: 1.0` next to `"177% of goal"`.
 */
export function meterPosition(saved: Money, goal: Money): number {
  if (isZero(goal)) return 1;
  return Math.min(1, Math.max(0, Math.round((saved.minor / goal.minor) * 10_000) / 10_000));
}

/**
 * What is still needed to reach the goal, or `null` once it is met.
 *
 * `null` rather than a zero, because the client's field is optional and a met goal has nothing left to
 * ask for — `home-inr.json` carries `"remaining": null` and `home-first-run.json` carries the full goal.
 */
export function remainingToGoal(saved: Money, goal: Money): Money | null {
  const remaining = subtract(goal, saved);
  return remaining.minor > 0 ? remaining : null;
}

/**
 * The four segments of the split bar: `needs / wants / min(saved, goal) / surplus`.
 *
 * The prototype's third segment was "left unspent", which under a residual definition of `saved` is
 * *identically zero* — every unspent dirham is already in `saved`. Product Spec §4.2 replaces it with
 * the surplus above goal, which is both non-zero and more informative.
 *
 * The four sum to income whenever nothing was overspent, which is what makes the bar a bar.
 */
export function splitSegments(output: BudgetOutput): {
  needs: Money;
  wants: Money;
  towardsGoal: Money;
  surplus: Money;
} {
  const towardsGoal = output.saved.minor < output.goal.minor ? output.saved : output.goal;
  return {
    needs: output.needs,
    wants: output.wantsSpent,
    towardsGoal,
    surplus: output.surplus,
  };
}

/** Total outgoing spend: needs plus wants. What Home's donut totals and its "% of pay" reads against. */
export const totalSpent = (output: BudgetOutput): Money =>
  sum([output.needs, output.wantsSpent], output.income.currency);
