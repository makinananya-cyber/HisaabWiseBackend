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
}

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
 * The two branches are Product Spec §4.2 verbatim:
 *
 * ```
 * if needs ≤ 50% of income:   wantsAllowance = 30% of income;  savingsAllowance = 20% of income
 * else:                        remainder = max(0, income − needs)
 *                              wantsAllowance = savingsAllowance = remainder / 2;  adapted = true
 * ```
 *
 * **Why `saved` is a residual and not a measurement.** There is no bank link and no savings-transfer
 * ledger, so the app cannot know what was truly set aside. Since all spending is either needs or wants,
 * the residual is the only quantity the server can honestly derive. It clamps at zero; `net` carries the
 * truth for someone who overspent.
 *
 * The comparison is `needs × 2 ≤ income` rather than `needs ≤ income × 0.5`, so the 50% boundary is
 * decided in integers. At exactly 50% — `budget-aed.json`'s case — the plain branch is taken, which is
 * what "needs ≤ 50%" says and what the fixture's `adapted: false` confirms.
 */
export function computeBudget(input: BudgetInput): BudgetOutput {
  const { income, needs, wantsSpent, goal } = input;

  const adapted = needs.minor * 2 > income.minor;

  let wantsAllowance: Money;
  let savingsAllowance: Money;
  if (adapted) {
    const remainder = clampToZero(subtract(income, needs));
    // Equal halves, as specified. Both rounded the same way rather than one taking the remainder, so
    // the two allowances a user is shown are the same number — an asymmetric split would read as a bug.
    wantsAllowance = fraction(remainder, 1, 2);
    savingsAllowance = fraction(remainder, 1, 2);
  } else {
    wantsAllowance = fraction(income, 30, 100);
    savingsAllowance = fraction(income, 20, 100);
  }

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
