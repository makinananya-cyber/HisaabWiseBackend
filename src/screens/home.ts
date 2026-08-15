import { getContent, type Language } from '../content';
import {
  computeBudget,
  meterPosition,
  meterVerdictFor,
  remainingToGoal,
  totalSpent,
  suggestedSavingsGoal,
  type MeterVerdict,
} from '../domain/budget';
import {
  convert,
  currencyToken,
  fraction,
  percentageLabel,
  present,
  shareOf,
  sum,
  tokenGap,
  wholePercentages,
  type DisplayMoney,
  type RateSet,
} from '../domain/money';
import { dayKey } from '../domain/time';
import type { User } from '../repositories/users';
import { money, type Money } from '../types/money';

/**
 * `GET /v1/screens/home` — **the single request Home makes** (ADR-0020).
 *
 * Everything on the screen arrives computed: the "% of pay" readout, the donut's shares and colour
 * slots, the meter's fill and verdict, the day's tip, the streak, and the article teasers. The client
 * sums nothing, thresholds nothing, and owns no calendar.
 *
 * That is not a convenience. A screen that composes four responses is a screen that derives the join,
 * and the prototype's version of that join is defect D1: Home hardcoded `salary: 8000` while the Account
 * screen defaulted to ₹65,000, so the same user's "% of pay" was computed against two different
 * salaries. Here the salary is read from the user document once, and every figure on the screen descends
 * from it.
 */

// ── The categories, in the order Home draws them ──────────────────────────────────────────────

/**
 * The six outgoing categories and their donut colour slots.
 *
 * **This order is the design's, not alphabetical and not by amount** — `rent, groceries, transport,
 * utilities, entertainment, other`, transcribed from the prototype's `state.spend`, which carries the
 * `slot` numbers explicitly. The slot is a *colour*, so it must be stable across months: sorting by
 * amount would make Rent change colour the month somebody spends more on groceries.
 *
 * `income` is absent because it is the only `flow: "in"` category — it is additional income, which lifts
 * the allowances rather than appearing in the spending donut (O1 resolution).
 */
export const HOME_CATEGORY_SLOTS = [
  { id: 'rent', name: 'Rent', slot: 1 },
  { id: 'groceries', name: 'Groceries', slot: 2 },
  { id: 'transport', name: 'Transport', slot: 3 },
  { id: 'utilities', name: 'Utilities', slot: 4 },
  { id: 'entertainment', name: 'Entertainment', slot: 5 },
  { id: 'other', name: 'Other', slot: 6 },
] as const;

export type HomeCategoryId = (typeof HOME_CATEGORY_SLOTS)[number]['id'];

/**
 * What the month's spending amounts to, per category, in **one** currency.
 *
 * Supplied by the caller rather than read here, which is what lets Home be built and tested before the
 * expense collections exist (slice 4) and keeps this module free of database access. Every value is
 * already converted to the reader's display currency and is exact — no display rounding has touched it.
 */
export interface MonthSpending {
  /** Per-category totals for the six outgoing categories. Absent or zero means "nothing logged". */
  readonly byCategory: Readonly<Partial<Record<HomeCategoryId, Money>>>;
  /** Additional income logged this month. Lifts every allowance (O1). */
  readonly additionalIncome: Money;
}

/** What the reader's Learn progress amounts to. Supplied for the same reason as `MonthSpending`. */
export interface LearnStanding {
  readonly streak: number;
  readonly xp: number;
  /** The title of the next lesson to attempt, or `undefined` when every lesson is done. */
  readonly nextLessonTitle: string | undefined;
}

// ── Labels ────────────────────────────────────────────────────────────────────────────────────

/**
 * `"Good morning"` / `"Good afternoon"` / `"Good evening"`, by the reader's local hour.
 *
 * **In the stored timezone, not the server's** (invariant 6). A Dubai user opening the app at 8am must
 * not be greeted with "Good evening" because the process happens to run in Virginia.
 */
export function greetingFor(instant: Date, timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(instant),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * `"Tuesday, 11 August"` — the client prints it verbatim, so the server owns the calendar.
 *
 * Assembled from two formatters rather than one, because a single `en-GB` format with `weekday`, `day` and
 * `month` yields `"Thursday 13 August"` — **no comma**, which is not what the design carries. The comma is
 * part of the string the client draws, so it has to be put there rather than hoped for from a locale.
 */
export function dateLabelFor(instant: Date, timezone: string): string {
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(instant);
  const dayAndMonth = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
  }).format(instant);
  return `${weekday}, ${dayAndMonth}`;
}

/** `"August"`. */
export const monthLabelFor = (instant: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, month: 'long' }).format(instant);

/**
 * Which tip the reader sees today.
 *
 * **Chosen server-side from the day key, and it must be stable within a day** — a tip that changed on
 * every request would make the card flicker on each foreground. So it is a deterministic function of the
 * day key rather than random, and of the *user's* day key rather than UTC's, so the tip turns over at the
 * reader's midnight.
 *
 * The user id is folded in so two people do not see the same tip on the same day, which would make the
 * feature feel like a broadcast rather than a suggestion.
 */
export function tipIndexFor(dayKeyValue: string, userId: string, poolSize: number): number {
  let hash = 0;
  for (const character of `${dayKeyValue}:${userId}`) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash % poolSize;
}

/**
 * `"120 XP · next up, Needs vs. Wants"`, or the first-run form.
 *
 * The prototype writes this in the browser; it is here because the client prints it verbatim and because
 * the pluralisation and the "no XP yet" branch are content decisions, not layout ones.
 */
export function learningSummary(standing: LearnStanding): string {
  if (standing.nextLessonTitle === undefined) {
    return standing.xp === 0 ? 'No XP yet' : `${String(standing.xp)} XP · every lesson complete`;
  }
  if (standing.xp === 0) return `No XP yet · start with ${standing.nextLessonTitle}`;
  return `${String(standing.xp)} XP · next up, ${standing.nextLessonTitle}`;
}

// ── The payload ───────────────────────────────────────────────────────────────────────────────

export interface HomePayload {
  readonly greeting: string;
  readonly name: string;
  readonly dateLabel: string;
  readonly monthLabel: string;
  readonly spending: {
    readonly total: DisplayMoney;
    readonly shareOfPayLabel: string;
    readonly isFirstRun: boolean;
    readonly categories: {
      readonly id: string;
      readonly name: string;
      readonly amount: DisplayMoney;
      readonly share: number;
      readonly shareLabel: string;
      readonly slot: number;
    }[];
  };
  readonly savings: {
    readonly saved: DisplayMoney;
    readonly goal: DisplayMoney;
    readonly zeroLabel: string;
    readonly percentageLabel: string;
    readonly position: number;
    readonly verdict: MeterVerdict;
    readonly remaining: DisplayMoney | null;
    /**
     * What the goal would be at a fifth of today's pay, when that is **more** than the stored goal.
     *
     * `null` is the ordinary case and means "say nothing". It is only non-null when a raise has left the
     * goal behind, which is the one moment the suggestion is worth a reader's attention.
     */
    readonly goalNudge: {
      readonly suggested: DisplayMoney;
      readonly current: DisplayMoney;
    } | null;
  };
  readonly tip: {
    readonly id: string;
    readonly dayKey: string;
    readonly text: string;
    readonly currencyToken: string;
  };
  readonly learning: {
    readonly streak: number;
    readonly summary: string;
    readonly nextLesson: string;
  };
  readonly articles: {
    readonly id: string;
    readonly short: string;
    readonly icon: string;
    readonly accent: number;
  }[];
}

export interface HomeInput {
  readonly user: User;
  readonly now: Date;
  readonly rates: RateSet | undefined;
  readonly spending: MonthSpending;
  readonly learning: LearnStanding;
  readonly language: Language;
}

/**
 * Build the Home payload.
 *
 * The order of operations is the substance. Salary and goal are converted into the reader's display
 * currency **exactly** — `presentIn` converts, and only the final `present` applies the rounding ladder —
 * so the budget engine never sees a figure that has been through a display formatter. That is the whole
 * of defect D16, and the reason `convert` and `present` are two functions rather than one.
 */
export function buildHome(input: HomeInput): HomePayload {
  const { user, now, rates, spending, learning, language } = input;
  const currency = user.displayCurrency;
  const content = getContent(language);

  const localDayKey = dayKey(now, user.timezone);

  // Every figure into one currency, **exactly**, before any arithmetic. `convert` and not `presentIn`:
  // the rounding ladder must not touch a value the budget engine is about to read (defect D16).
  const inCurrency = (amount: Money): Money => convert(amount, currency, rates);

  const salary = inCurrency(user.salary);
  const goal = inCurrency(user.savingsGoal);
  const additionalIncome = inCurrency(spending.additionalIncome);

  const categoryAmounts = HOME_CATEGORY_SLOTS.map((category) => ({
    ...category,
    amount: inCurrency(spending.byCategory[category.id] ?? money(0, currency)),
  }));

  const amountOf = (id: HomeCategoryId): Money =>
    categoryAmounts.find((category) => category.id === id)?.amount ?? money(0, currency);

  // needs = rent + utilities + groceries; wants = transport + entertainment + other (DATA_MODEL §2).
  const needs = sum([amountOf('rent'), amountOf('utilities'), amountOf('groceries')], currency);
  const wantsSpent = sum([amountOf('transport'), amountOf('entertainment'), amountOf('other')], currency);

  const budget = computeBudget({
    income: { ...salary, minor: salary.minor + additionalIncome.minor },
    needs,
    wantsSpent,
    goal,
  });

  const total = totalSpent(budget);
  // A month with nothing logged is a genuinely different screen — an empty donut with copy rather than a
  // zero-value chart — so the server says which one it is rather than letting the client infer it from a
  // zero that could also be a real month of no spending.
  const isFirstRun = total.minor === 0;

  const tipPool = content.tips.value.tips;
  const tip = tipPool[tipIndexFor(localDayKey, user._id.toHexString(), tipPool.length)] ?? tipPool[0];

  const remaining = remainingToGoal(budget.saved, goal);

  /**
   * The goal nudge, or nothing.
   *
   * **Only when the suggestion is higher**, because a raise is the case worth mentioning and "you could
   * save less" is not advice this app should offer. The threshold is one percent of pay rather than one
   * minor unit, so a goal that is merely a rounding or an exchange-rate tick away from a fifth of pay does
   * not put a card on somebody's Home screen every morning.
   */
  const suggestedGoal = suggestedSavingsGoal(salary);
  const nudgeThreshold = Math.max(1, fraction(salary, 1, 100).minor);
  const goalNudge =
    suggestedGoal.minor - goal.minor >= nudgeThreshold
      ? { suggested: present(suggestedGoal), current: present(goal) }
      : null;

  // Allocated once, for the whole legend, so the column adds up to the figure in the middle of the donut.
  const categoryShareLabels = wholePercentages(
    categoryAmounts.map((category) => category.amount),
    total,
  );

  return {
    greeting: greetingFor(now, user.timezone),
    name: user.displayName,
    dateLabel: dateLabelFor(now, user.timezone),
    monthLabel: monthLabelFor(now, user.timezone),

    spending: {
      total: present(total),
      // "% of pay" is computed against the server-owned salary — defect D1's fix, in one line.
      shareOfPayLabel: percentageLabel(total, salary, 'of pay'),
      isFirstRun,
      // An empty donut carries no segments; a populated one carries every category, including a zero,
      // so the legend does not change shape as the month fills in.
      categories: isFirstRun
        ? []
        : categoryAmounts.map((category, index) => ({
            id: category.id,
            name: category.name,
            amount: present(category.amount),
            // The share is computed from the *unrounded* amounts, so a 54.16% slice draws at 54.16%.
            share: shareOf(category.amount, total),
            // The *labels* are allocated as a set rather than rounded one at a time, because a legend
            // under a donut is read as a column that adds up — and rounding each on its own printed 101%.
            shareLabel: `${String(categoryShareLabels[index] ?? 0)}%`,
            slot: category.slot,
          })),
    },

    savings: {
      saved: present(budget.saved),
      goal: present(goal),
      zeroLabel: present(money(0, currency)).display,
      percentageLabel: percentageLabel(budget.saved, goal, 'of goal'),
      position: meterPosition(budget.saved, goal),
      verdict: meterVerdictFor(budget.saved, goal),
      remaining: remaining === null ? null : present(remaining),
      goalNudge,
    },

    tip: {
      id: tip?.id ?? '',
      dayKey: localDayKey,
      // The **raw** text with its `{c}` tokens intact, plus the token to substitute. The client resolves
      // it so that "Show me another" can cycle the pool in memory rather than costing a request per tap
      // (iOS ADR-0016) — which is why the token travels beside the text instead of being applied here.
      text: tip?.text ?? '',
      // `"₹"` for a single glyph, `"AED "` *with* its trailing space for a code — the client substitutes
      // this straight into "{c}6,400", and `AED6,400` is what happens if the gap is left behind.
      currencyToken: `${currencyToken(currency)}${tokenGap(currencyToken(currency))}`,
    },

    learning: {
      streak: learning.streak,
      summary: learningSummary(learning),
      nextLesson: learning.nextLessonTitle ?? '',
    },

    articles: content.articleTeasers.value.articles.map((article) => ({
      id: article.id,
      short: article.short,
      icon: article.icon,
      accent: article.accent,
    })),
  };
}

