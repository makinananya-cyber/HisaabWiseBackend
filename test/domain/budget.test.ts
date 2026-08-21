import { describe, expect, it } from 'vitest';

import { loadContent } from '../../src/content';
import {
  computeBudget,
  effectiveWantsShare,
  feasibleWantsShares,
  meterPosition,
  meterVerdictFor,
  remainingToGoal,
  splitSegments,
  totalSpent,
  verdictFor,
  wantsAllowanceForShare,
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

describe('the split — needs, then wants, then savings as the residual', () => {
  /**
   * The default share (30) against `inr`'s 46%-of-income needs: 30% of income to wants, and whatever is left
   * to savings — **not** a flat 20%. The residual is `income − needs − wants` = 6.5M − 3M − 1.95M = 1.55M.
   */
  it('gives wants the chosen share and savings the rest', () => {
    const budget = computeBudget(inr());

    expect(budget.wantsAllowance).toEqual(money(1_950_000, 'INR')); // 30% of ₹65,000
    expect(budget.savingsAllowance).toEqual(money(1_550_000, 'INR')); // the residual, not 20%
    expect(budget.adapted).toBe(false);
  });

  /**
   * The requirement stated plainly: a reader with **no essential costs** who takes the 40% ceiling is left
   * with 60% for savings. income − needs − wants = 100% − 0% − 40% = 60%.
   */
  it('gives 40% wants and 60% savings when there are no needs', () => {
    const budget = computeBudget({
      income: money(1_000_000, 'AED'),
      needs: money(0, 'AED'),
      wantsSpent: money(0, 'AED'),
      goal: money(0, 'AED'),
      wantsSharePercent: 40,
    });

    expect(budget.wantsAllowance).toEqual(money(400_000, 'AED')); // 40%
    expect(budget.savingsAllowance).toEqual(money(600_000, 'AED')); // 60%
  });

  /** `null` (unset) applies the default 30, exactly as an explicit 30 does. */
  it('treats an unset share as the default 30', () => {
    expect(computeBudget(inr({ wantsSharePercent: null }))).toEqual(
      computeBudget(inr({ wantsSharePercent: 30 })),
    );
  });

  /**
   * `budget-aed.json`'s case: needs are *exactly* 50% of income. Here the residual and the old flat-20%
   * happen to coincide — needs 50%, wants 30%, so savings is the remaining 20% either way.
   */
  it('takes the plain branch at exactly 50% of income', () => {
    const budget = computeBudget({
      income: money(800_000, 'AED'),
      needs: money(400_000, 'AED'),
      wantsSpent: money(150_000, 'AED'),
      goal: money(160_000, 'AED'),
    });

    expect(budget.adapted).toBe(false);
    expect(budget.wantsAllowance).toEqual(money(240_000, 'AED')); // 30%
    expect(budget.savingsAllowance).toEqual(money(160_000, 'AED')); // residual, = 20% here
    expect(budget.saved).toEqual(money(250_000, 'AED'));
    expect(budget.surplus).toEqual(money(90_000, 'AED'));
    expect(budget.verdict).toBe('hit');
  });
});

describe('the wants budget never exceeds what is left after needs', () => {
  /**
   * When rent already eats most of the pay, a 40% wants share is capped at the money that actually exists —
   * the reader is never shown a budget larger than `income − needs`, and savings simply reaches zero.
   */
  it('caps the wants allowance at the available pool', () => {
    const budget = computeBudget({
      income: money(800_000, 'AED'),
      needs: money(600_000, 'AED'),
      wantsSpent: money(50_000, 'AED'),
      goal: money(0, 'AED'),
      wantsSharePercent: 40,
    });

    // 40% of 8,000 is 3,200, but only 2,000 is left after needs — so the budget is 2,000, not 3,200.
    expect(budget.wantsAllowance).toEqual(money(200_000, 'AED'));
    expect(budget.savingsAllowance).toEqual(money(0, 'AED'));
    expect(budget.adapted).toBe(true);
  });

  it('allows nothing when needs exceed income entirely', () => {
    const budget = computeBudget({
      income: money(500_000, 'AED'),
      needs: money(700_000, 'AED'),
      wantsSpent: money(0, 'AED'),
      goal: money(100_000, 'AED'),
    });

    expect(budget.wantsAllowance).toEqual(money(0, 'AED'));
    expect(budget.savingsAllowance).toEqual(money(0, 'AED'));
    expect(budget.adapted).toBe(true);
  });
});

describe('feasible shares and the effective clamp', () => {
  /**
   * Only the shares that still leave the savings goal reachable are offered, and they are always the run
   * from the floor up to a ceiling. For `inr` (needs 46%, goal ₹13,000) that ceiling is 30%: 35% would
   * leave ₹12,250 and 40% would leave ₹9,000, both under the goal.
   */
  it('offers the run of shares that keep the goal reachable', () => {
    expect(feasibleWantsShares(inr().income, inr().needs, inr().goal)).toEqual([10, 15, 20, 25, 30]);

    // A lower goal opens the ceiling back up to the full range.
    expect(feasibleWantsShares(inr().income, inr().needs, money(0, 'INR'))).toEqual([
      10, 15, 20, 25, 30, 35, 40,
    ]);
  });

  /** A request above the feasible ceiling is clamped down to it, so the goal is never quietly spent. */
  it('clamps a request that would break the goal down to the ceiling', () => {
    expect(effectiveWantsShare(inr().income, inr().needs, inr().goal, 40)).toBe(30);

    const clamped = computeBudget(inr({ wantsSharePercent: 40 }));
    // 40 was asked for but only 30 is feasible, so the allowance is 30%'s, not 40%'s.
    expect(clamped.wantsAllowance).toEqual(money(1_950_000, 'INR'));

    // With no goal to protect, 40 is honoured in full.
    const free = computeBudget(inr({ goal: money(0, 'INR'), wantsSharePercent: 40 }));
    expect(free.wantsAllowance).toEqual(money(2_600_000, 'INR'));
  });

  /**
   * When needs and the goal together already claim everything, the floor is still offered — the reader
   * needs *a* wants budget, and the smallest one saves the most.
   */
  it('always offers at least the floor, even when nothing meets the goal', () => {
    const income = money(500_000, 'AED');
    const needs = money(480_000, 'AED');
    const goal = money(100_000, 'AED');

    expect(feasibleWantsShares(income, needs, goal)).toEqual([10]);
    expect(effectiveWantsShare(income, needs, goal, 30)).toBe(10);
  });
});

describe('wantsAllowanceForShare — the per-option preview', () => {
  it('matches what computeBudget produces for a feasible share', () => {
    // 25% of ₹65,000 is feasible against the ₹13,000 goal, so preview and applied figure agree.
    const plain = inr();
    expect(wantsAllowanceForShare(plain.income, plain.needs, 25)).toEqual(
      computeBudget(inr({ wantsSharePercent: 25 })).wantsAllowance,
    );
  });

  it('caps the preview at the available pool, like the engine', () => {
    const income = money(800_000, 'AED');
    const needs = money(600_000, 'AED'); // only 2,000 left
    expect(wantsAllowanceForShare(income, needs, 40)).toEqual(money(200_000, 'AED'));
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
