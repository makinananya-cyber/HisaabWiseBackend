import { describe, expect, it } from 'vitest';

import { loadContent } from '../../src/content';
import {
  computeBudget,
  meterPosition,
  meterVerdictFor,
  remainingToGoal,
  splitSegments,
  totalSpent,
  verdictFor,
  type BudgetInput,
} from '../../src/domain/budget';
import { money } from '../../src/types/money';

/**
 * The budget engine — **the single source of truth for Home, Expenses and Reports** (invariant 3).
 *
 * The prototype computed `saved` in three places and reached three different answers, and carried two
 * disagreeing verdict tables for the same pill on the same number (Reports at 100/70, Home at 80/45).
 * That quiet disagreement is defect D1's shape, and the tests below are what stop it coming back: one
 * implementation, one table, and every branch asserted.
 */

loadContent();

/** The `budget-inr.json` scenario: ₹65,000 income, needs at 46% of it, so the plain branch. */
const inr = (overrides: Partial<BudgetInput> = {}): BudgetInput => ({
  income: money(6_500_000, 'INR'),
  needs: money(3_000_000, 'INR'),
  wantsSpent: money(1_200_000, 'INR'),
  goal: money(1_300_000, 'INR'),
  ...overrides,
});

describe('the plain branch — needs at or under 50% of income', () => {
  it('allows 30% for wants and 20% for savings', () => {
    const budget = computeBudget(inr());

    expect(budget.wantsAllowance).toEqual(money(1_950_000, 'INR'));
    expect(budget.savingsAllowance).toEqual(money(1_300_000, 'INR'));
    expect(budget.adapted).toBe(false);
  });

  /**
   * `budget-aed.json`'s case: needs are *exactly* 50% of income. "needs ≤ 50%" takes the plain branch,
   * and the fixture's `adapted: false` confirms it. The integer comparison `needs × 2 > income` is what
   * makes the boundary exact rather than a float away from it.
   */
  it('takes the plain branch at exactly 50%', () => {
    const budget = computeBudget({
      income: money(800_000, 'AED'),
      needs: money(400_000, 'AED'),
      wantsSpent: money(150_000, 'AED'),
      goal: money(160_000, 'AED'),
    });

    expect(budget.adapted).toBe(false);
    expect(budget.wantsAllowance).toEqual(money(240_000, 'AED'));
    expect(budget.savingsAllowance).toEqual(money(160_000, 'AED'));
    expect(budget.saved).toEqual(money(250_000, 'AED'));
    expect(budget.surplus).toEqual(money(90_000, 'AED'));
    expect(budget.verdict).toBe('hit');
  });
});

describe('the adaptive branch — needs over 50% of income', () => {
  /**
   * The degradation branch exists because the target user rents in a high-rent market: telling someone
   * whose rent is 60% of their pay that they may spend 30% on wants is arithmetic that does not fit
   * inside their income.
   */
  it('splits what is left equally between wants and savings', () => {
    const budget = computeBudget({
      income: money(800_000, 'AED'),
      needs: money(600_000, 'AED'),
      wantsSpent: money(50_000, 'AED'),
      goal: money(100_000, 'AED'),
    });

    expect(budget.adapted).toBe(true);
    // remainder = 8,000 − 6,000 = 2,000, halved.
    expect(budget.wantsAllowance).toEqual(money(100_000, 'AED'));
    expect(budget.savingsAllowance).toEqual(money(100_000, 'AED'));
  });

  it('gives equal halves rather than letting one take the remainder', () => {
    // An asymmetric split of an odd remainder would show a user two allowances that differ by a fil,
    // which reads as a bug rather than as rounding.
    const budget = computeBudget({
      income: money(1_001, 'AED'),
      needs: money(900, 'AED'),
      wantsSpent: money(0, 'AED'),
      goal: money(0, 'AED'),
    });

    expect(budget.wantsAllowance).toEqual(budget.savingsAllowance);
  });

  it('allows nothing when needs exceed income entirely', () => {
    const budget = computeBudget({
      income: money(500_000, 'AED'),
      needs: money(700_000, 'AED'),
      wantsSpent: money(0, 'AED'),
      goal: money(100_000, 'AED'),
    });

    // The remainder clamps at zero rather than going negative, so an allowance is never a negative
    // permission.
    expect(budget.wantsAllowance).toEqual(money(0, 'AED'));
    expect(budget.savingsAllowance).toEqual(money(0, 'AED'));
    expect(budget.adapted).toBe(true);
  });
});

describe('saved and net', () => {
  /**
   * `saved` is a **residual**, not a measurement. There is no bank link and no savings-transfer ledger,
   * so the app cannot know what was truly set aside; since all spending is either needs or wants, the
   * residual is the only quantity the server can honestly derive.
   */
  it('is income less needs less wants spent', () => {
    const budget = computeBudget(inr());

    expect(budget.saved).toEqual(money(2_300_000, 'INR'));
    expect(budget.net).toEqual(money(2_300_000, 'INR'));
    expect(budget.overspent).toBe(false);
  });

  it('clamps saved at zero while net carries the truth', () => {
    const budget = computeBudget({
      income: money(800_000, 'AED'),
      needs: money(600_000, 'AED'),
      wantsSpent: money(400_000, 'AED'),
      goal: money(100_000, 'AED'),
    });

    // A user who overspent by AED 2,000 is told so by `net`; `saved` does not go negative, because a
    // negative amount saved is not a thing that happened.
    expect(budget.net).toEqual(money(-200_000, 'AED'));
    expect(budget.saved).toEqual(money(0, 'AED'));
    expect(budget.overspent).toBe(true);
  });

  it('is not overspent at exactly zero', () => {
    const budget = computeBudget({
      income: money(800_000, 'AED'),
      needs: money(600_000, 'AED'),
      wantsSpent: money(200_000, 'AED'),
      goal: money(0, 'AED'),
    });

    expect(budget.net).toEqual(money(0, 'AED'));
    expect(budget.overspent).toBe(false);
  });

  it('never sees a figure that has been through a display formatter', () => {
    // Defect D16: the prototype quantised income by round-tripping salary through its formatter before
    // the engine saw it. A salary of ₹65,004.37 must produce a `saved` that reflects those paise, even
    // though the salary *displays* as ₹65,000.
    const budget = computeBudget(inr({ income: money(6_500_437, 'INR') }));

    expect(budget.saved.minor).toBe(6_500_437 - 3_000_000 - 1_200_000);
  });
});

describe('surplus', () => {
  it('is what was saved above the goal', () => {
    const budget = computeBudget(inr());

    // 23,000 saved against a 13,000 goal.
    expect(budget.surplus).toEqual(money(1_000_000, 'INR'));
  });

  it('is zero when the goal was not reached', () => {
    const budget = computeBudget(inr({ goal: money(5_000_000, 'INR') }));

    expect(budget.surplus).toEqual(money(0, 'INR'));
  });
});

describe('the verdict table', () => {
  /**
   * **One table, at 100/70.** Product Spec §4.2 settled the prototype's two disagreeing tables in favour
   * of Reports'; Home's 80/45 was the more generous one and is gone. The client never derives this.
   */
  const goal = money(1_000_000, 'AED');

  it('is hit at 100% and above', () => {
    expect(verdictFor(money(1_000_000, 'AED'), goal)).toBe('hit');
    expect(verdictFor(money(2_500_000, 'AED'), goal)).toBe('hit');
  });

  it('is near from 70% up to 100%', () => {
    expect(verdictFor(money(700_000, 'AED'), goal)).toBe('near');
    expect(verdictFor(money(994_000, 'AED'), goal)).toBe('near');
  });

  it('is miss below 70%', () => {
    expect(verdictFor(money(694_000, 'AED'), goal)).toBe('miss');
    expect(verdictFor(money(0, 'AED'), goal)).toBe('miss');
  });

  /**
   * **The threshold is applied to the rounded percentage, the same one the label prints.**
   *
   * So 99.9% is `hit`, because the label beside it reads "100% of goal" — and a pill saying "near" next to
   * a number saying 100% is precisely the disagreement defect D11 describes. The alternative (threshold on
   * the exact ratio) is more literally correct and produces a screen that looks broken.
   */
  it('thresholds on the whole percent the label shows, so the pill and the number agree', () => {
    expect(verdictFor(money(999_000, 'AED'), goal)).toBe('hit');
    expect(verdictFor(money(995_000, 'AED'), goal)).toBe('hit');
    expect(verdictFor(money(699_000, 'AED'), goal)).toBe('near');
    expect(verdictFor(money(695_000, 'AED'), goal)).toBe('near');
  });

  /** A goal of zero is met by definition: there is nothing to miss (Product Spec §4.2). */
  it('is hit against a goal of zero', () => {
    expect(verdictFor(money(0, 'AED'), money(0, 'AED'))).toBe('hit');
  });

  it('maps onto Home\'s meter names without changing the thresholds', () => {
    // Home says `met`/`onTrack`/`low` because it draws a meter rather than a pill. Same numbers.
    expect(meterVerdictFor(money(1_000_000, 'AED'), goal)).toBe('met');
    expect(meterVerdictFor(money(700_000, 'AED'), goal)).toBe('onTrack');
    expect(meterVerdictFor(money(0, 'AED'), goal)).toBe('low');
  });
});

describe('the savings meter', () => {
  const goal = money(1_300_000, 'INR');

  it('fills proportionally', () => {
    expect(meterPosition(money(650_000, 'INR'), goal)).toBe(0.5);
  });

  it('clamps at full, because 177% of a goal is still a full bar', () => {
    // `home-inr.json` carries `position: 1.0` beside `"177% of goal"` — the label carries the real
    // figure, the bar carries the progress.
    expect(meterPosition(money(2_300_000, 'INR'), goal)).toBe(1);
  });

  it('is empty at zero and full against a zero goal', () => {
    expect(meterPosition(money(0, 'INR'), goal)).toBe(0);
    expect(meterPosition(money(0, 'INR'), money(0, 'INR'))).toBe(1);
  });

  it('reports what is left, and null once there is nothing left', () => {
    // The client's field is optional: a met goal has nothing to ask for.
    expect(remainingToGoal(money(0, 'INR'), goal)).toEqual(money(1_300_000, 'INR'));
    expect(remainingToGoal(money(1_300_000, 'INR'), goal)).toBeNull();
    expect(remainingToGoal(money(2_300_000, 'INR'), goal)).toBeNull();
  });
});

describe('the split bar', () => {
  /**
   * Four segments: `needs / wants / min(saved, goal) / surplus`. The prototype's third segment was "left
   * unspent", which under a residual definition of `saved` is *identically zero* — every unspent dirham is
   * already in `saved`. Product Spec §4.2 replaced it with the surplus above goal.
   */
  it('has four segments that sum to income when nothing was overspent', () => {
    const budget = computeBudget(inr());
    const segments = splitSegments(budget);

    const total =
      segments.needs.minor + segments.wants.minor + segments.towardsGoal.minor + segments.surplus.minor;
    expect(total).toBe(budget.income.minor);
  });

  it('caps the towards-goal segment at the goal, so the surplus is visible', () => {
    const segments = splitSegments(computeBudget(inr()));

    expect(segments.towardsGoal).toEqual(money(1_300_000, 'INR'));
    expect(segments.surplus).toEqual(money(1_000_000, 'INR'));
  });

  it('shows no surplus when the goal was not reached', () => {
    const segments = splitSegments(computeBudget(inr({ goal: money(5_000_000, 'INR') })));

    expect(segments.towardsGoal).toEqual(money(2_300_000, 'INR'));
    expect(segments.surplus).toEqual(money(0, 'INR'));
  });
});

describe('additional income', () => {
  /**
   * The O1 resolution: additional income **lifts the allowances** rather than routing to savings, so
   * `income = salary + additionalIncome` and 50/30/20 runs against the total. This is the prototype's own
   * behaviour, so no screen changes meaning.
   */
  it('raises all three allowances', () => {
    const withoutExtra = computeBudget(inr());
    const withExtra = computeBudget(inr({ income: money(7_500_000, 'INR') }));

    expect(withExtra.wantsAllowance.minor).toBeGreaterThan(withoutExtra.wantsAllowance.minor);
    expect(withExtra.savingsAllowance.minor).toBeGreaterThan(withoutExtra.savingsAllowance.minor);
    // And it raises `saved`, because the residual is bigger.
    expect(withExtra.saved.minor).toBeGreaterThan(withoutExtra.saved.minor);
  });

  it('can move a user off the adaptive branch', () => {
    const base: BudgetInput = {
      income: money(1_000_000, 'AED'),
      needs: money(600_000, 'AED'),
      wantsSpent: money(0, 'AED'),
      goal: money(0, 'AED'),
    };

    expect(computeBudget(base).adapted).toBe(true);
    expect(computeBudget({ ...base, income: money(1_400_000, 'AED') }).adapted).toBe(false);
  });
});

describe('totalSpent', () => {
  it('is needs plus wants, and nothing else', () => {
    // Additional income is `flow: "in"` and never appears in the spending total.
    expect(totalSpent(computeBudget(inr()))).toEqual(money(4_200_000, 'INR'));
  });
});
