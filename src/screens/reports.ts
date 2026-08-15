import { computeBudget, verdictFor, type Verdict } from '../domain/budget';
import {
  convert,
  percentage,
  present,
  shareOf,
  sum,
  wholePercentages,
  type DisplayMoney,
  type RateSet,
} from '../domain/money';
import type { MonthArchive } from '../repositories/monthArchives';
import type { User } from '../repositories/users';
import { money, type Money } from '../types/money';
import { CATEGORIES, NEEDS_CATEGORIES, WANTS_CATEGORIES, utilityIconFor, type CategoryId } from './expenses';
import { HOME_CATEGORY_SLOTS } from './home';

/**
 * Reports — the archive, read.
 *
 * **Invariant 7 lives here.** An archived month is immutable and carries the FX rate set pinned at close, so
 * re-reading it in another display currency converts every figure through *those* rates and changes no
 * verdict. That is a property of what this answers with rather than of anything the client does: `saved`,
 * `net`, `verdict` and `adapted` are read from the document, never recomputed, because recomputing them
 * against a different rate set could flip a met goal to a near miss — defect D6.
 *
 * Everything else is derived from the stored entries at read time (DATA_MODEL §3.4): per-category totals,
 * the four split-bar segments, the six facts, every share and every label.
 */

/** Month names, for the labels the client prints verbatim. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const monthName = (monthKey: string): string => MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1] ?? monthKey;
const yearOf = (monthKey: string): string => monthKey.slice(0, 4);

/**
 * Everything one archived month amounts to, in the reader's display currency.
 *
 * Converted through the **pinned** rate set, so a report converts the same way forever.
 */
interface ArchiveTotals {
  readonly income: Money;
  readonly salary: Money;
  readonly additionalIncome: Money;
  readonly goal: Money;
  readonly saved: Money;
  readonly net: Money;
  readonly byCategory: Record<CategoryId, Money>;
  readonly needs: Money;
  readonly wantsSpent: Money;
  readonly fixed: Money;
  readonly variable: Money;
  readonly spent: Money;
  readonly entriesByCategory: Record<string, { label: string; amount: Money; entryDate: Date | null }[]>;
}

function totalsOf(archive: MonthArchive, currency: string, rates: RateSet | undefined): ArchiveTotals {
  const inCurrency = (amount: Money): Money => convert(amount, currency, rates);

  const entriesByCategory: Record<string, { label: string; amount: Money; entryDate: Date | null }[]> = {};
  for (const category of CATEGORIES) entriesByCategory[category.id] = [];

  for (const entry of archive.entries) {
    entriesByCategory[entry.category]?.push({
      label: entry.label,
      amount: inCurrency(entry.amount),
      entryDate: entry.entryDate,
    });
  }

  // A fixed cost and a bill line are shown as entries too, dated "Fixed each month".
  const rent = inCurrency(archive.fixed.rent);
  if (rent.minor > 0) entriesByCategory.rent?.push({ label: 'Rent', amount: rent, entryDate: null });
  for (const line of archive.fixed.utilityLines) {
    entriesByCategory.utilities?.push({
      label: line.name,
      amount: inCurrency(line.amount),
      entryDate: null,
    });
  }

  const totalOf = (id: CategoryId): Money =>
    sum(entriesByCategory[id]?.map((entry) => entry.amount) ?? [], currency);

  const byCategory = Object.fromEntries(
    CATEGORIES.map((category) => [category.id, totalOf(category.id)]),
  ) as Record<CategoryId, Money>;

  const needs = sum(NEEDS_CATEGORIES.map((id) => byCategory[id]), currency);
  const wantsSpent = sum(WANTS_CATEGORIES.map((id) => byCategory[id]), currency);
  const fixed = sum([byCategory.rent, byCategory.utilities], currency);
  const variable = sum(
    [byCategory.groceries, byCategory.transport, byCategory.entertainment, byCategory.other],
    currency,
  );
  const salary = inCurrency(archive.salary);
  const additionalIncome = byCategory.income;

  return {
    salary,
    additionalIncome,
    income: { ...salary, minor: salary.minor + additionalIncome.minor },
    goal: inCurrency(archive.goal),
    // **Read, not recomputed** — invariant 7.
    saved: inCurrency(archive.saved),
    net: inCurrency(archive.net),
    byCategory,
    needs,
    wantsSpent,
    fixed,
    variable,
    spent: sum([fixed, variable], currency),
    entriesByCategory,
  };
}

// ── One month in full ─────────────────────────────────────────────────────────────────────────

export interface MonthReport {
  readonly monthKey: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly percentageLabel: string;
  readonly totals: {
    spent: DisplayMoney;
    fixed: DisplayMoney;
    variable: DisplayMoney;
    additionalIncome: DisplayMoney;
    isAdapted: boolean;
  };
  readonly spending: {
    shareOfIncomeLabel: string;
    categoryCountLabel: string;
    categories: {
      id: string;
      name: string;
      amount: DisplayMoney;
      share: number;
      shareLabel: string;
      slot: number;
    }[];
  };
  readonly savings: {
    saved: DisplayMoney;
    goal: DisplayMoney;
    zeroLabel: string;
    position: number;
    shareOfIncomeLabel: string;
    remaining: DisplayMoney | null;
  };
  readonly wants: {
    used: DisplayMoney;
    allowance: DisplayMoney;
    percentageLabel: string;
    fill: number;
    isOver: boolean;
    remaining: DisplayMoney | null;
  };
  readonly split: {
    income: DisplayMoney;
    segments: { portion: string; amount: DisplayMoney; share: number; target?: DisplayMoney }[];
  };
  readonly groups: {
    id: string;
    name: string;
    slot: number;
    icon: string;
    flow: string;
    total: DisplayMoney;
    summaryLabel: string;
    entries: { label: string; dateLabel: string; amount: DisplayMoney }[];
  }[];
  readonly facts: { kind: string; value: string; note?: string }[];
}

/**
 * Build one closed month's report.
 *
 * The reason this is long rather than clever: every figure the design shows is a named field, and the
 * client has no formatter and no arithmetic. A shorter version would be one that made the client derive
 * something.
 */
export function buildMonthReport(
  archive: MonthArchive,
  user: User,
  rates: RateSet | undefined,
): MonthReport {
  const currency = user.displayCurrency;
  const totals = totalsOf(archive, currency, rates);
  const zero = money(0, currency);

  // Recomputed only for the *allowances*, which are a function of income and are not part of the month's
  // story. `saved`, `net`, `verdict` and `adapted` come from the document.
  const budget = computeBudget({
    income: totals.income,
    needs: totals.needs,
    wantsSpent: totals.wantsSpent,
    goal: totals.goal,
  });

  const spendingCategories = HOME_CATEGORY_SLOTS.map((slot) => ({
    ...slot,
    amount: totals.byCategory[slot.id],
  })).filter((category) => category.amount.minor > 0);

  const wantsRemaining = budget.wantsAllowance.minor - totals.wantsSpent.minor;
  const savingsRemaining = totals.goal.minor - totals.saved.minor;

  const biggest = [...spendingCategories].sort((a, b) => b.amount.minor - a.amount.minor)[0];

  const categoryShareLabels = wholePercentages(
    spendingCategories.map((category) => category.amount),
    totals.spent,
  );

  return {
    monthKey: archive.monthKey,
    title: `${monthName(archive.monthKey)} ${yearOf(archive.monthKey)}`,
    // Sealed at close. Re-reading in another currency must not change it (invariant 7).
    verdict: archive.verdict,
    percentageLabel: `${String(percentage(totals.saved, totals.goal))}% of goal`,

    totals: {
      spent: present(totals.spent),
      fixed: present(totals.fixed),
      variable: present(totals.variable),
      additionalIncome: present(totals.additionalIncome),
      isAdapted: archive.adapted,
    },

    spending: {
      shareOfIncomeLabel: `${String(percentage(totals.spent, totals.income))}% of income`,
      categoryCountLabel:
        spendingCategories.length === 0
          ? 'No categories'
          : `${String(spendingCategories.length)} categor${spendingCategories.length === 1 ? 'y' : 'ies'}`,
      categories: spendingCategories.map((category, index) => ({
        id: category.id,
        name: category.name,
        amount: present(category.amount),
        share: shareOf(category.amount, totals.spent),
        // Allocated as a set, for the same reason as Home's legend: a column under a donut is read as
        // adding up, and rounding each row on its own does not.
        shareLabel: `${String(categoryShareLabels[index] ?? 0)}%`,
        slot: category.slot,
      })),
    },

    savings: {
      saved: present(totals.saved),
      goal: present(totals.goal),
      zeroLabel: present(zero).display,
      position:
        totals.goal.minor === 0 ? 1 : Math.min(1, Math.round((totals.saved.minor / totals.goal.minor) * 100) / 100),
      shareOfIncomeLabel: `${String(percentage(totals.saved, totals.income))}% of income saved`,
      remaining: savingsRemaining > 0 ? present({ ...zero, minor: savingsRemaining }) : null,
    },

    wants: {
      used: present(totals.wantsSpent),
      allowance: present(budget.wantsAllowance),
      percentageLabel: `${String(
        budget.wantsAllowance.minor === 0 ? 0 : percentage(totals.wantsSpent, budget.wantsAllowance),
      )}%`,
      fill:
        budget.wantsAllowance.minor === 0
          ? 0
          : Math.min(1, Math.round((totals.wantsSpent.minor / budget.wantsAllowance.minor) * 10_000) / 10_000),
      isOver: totals.wantsSpent.minor > budget.wantsAllowance.minor,
      remaining: wantsRemaining > 0 ? present({ ...zero, minor: wantsRemaining }) : null,
    },

    /**
     * The four segments: `needs / wants / min(saved, goal) / surplus`.
     *
     * The prototype's third segment was "left unspent", which under a residual definition of `saved` is
     * identically zero — Product Spec §4.2 replaced it with the surplus above goal. The `surplus` segment
     * carries **no target**, because there is nothing it is supposed to be.
     */
    split: {
      income: present(totals.income),
      segments: [
        {
          portion: 'needs',
          amount: present(totals.needs),
          share: shareOf(totals.needs, totals.income),
          target: present({ ...zero, minor: Math.round(totals.income.minor / 2) }),
        },
        {
          portion: 'wants',
          amount: present(totals.wantsSpent),
          share: shareOf(totals.wantsSpent, totals.income),
          target: present(budget.wantsAllowance),
        },
        {
          portion: 'saved',
          amount: present(totals.saved),
          share: shareOf(totals.saved, totals.income),
          target: present(budget.savingsAllowance),
        },
        {
          portion: 'surplus',
          amount: present(budget.surplus),
          share: shareOf(budget.surplus, totals.income),
        },
      ],
    },

    /**
     * Every category, in Expenses' order, **including the empty ones**.
     *
     * The spending donut above shows only what was spent; this list is the month's record and a category
     * with nothing in it is a fact about the month. `reports-month-quiet.json` has seven groups and zero
     * donut categories, which is exactly that distinction.
     */
    groups: CATEGORIES.map((category) => {
      const entries = totals.entriesByCategory[category.id] ?? [];
      const total = totals.byCategory[category.id];
      const shareLabel = `${String(percentage(total, totals.spent))}% of spend`;

      return {
        id: category.id,
        name: category.name,
        slot: HOME_CATEGORY_SLOTS.find((slot) => slot.id === category.id)?.slot ?? 0,
        icon: category.icon,
        flow: category.flow,
        total: present(total),
        summaryLabel:
          entries.length === 0
            ? 'Nothing recorded'
            : `${String(entries.length)} ${entries.length === 1 ? 'entry' : 'entries'} · ${shareLabel}`,
        entries: entries.map((entry) => ({
          label: entry.label,
          // A fixed cost has no date — it is the month itself. A logged entry carries its real day.
          dateLabel:
            entry.entryDate === null
              ? 'Fixed each month'
              : `${String(entry.entryDate.getUTCDate())} ${monthName(archive.monthKey).slice(0, 3)}`,
          amount: present(entry.amount),
        })),
      };
    }),

    /** The six "For the record" facts, in the design's order. */
    facts: [
      {
        kind: 'salary',
        value: present(totals.salary).display,
        note:
          totals.additionalIncome.minor === 0
            ? 'No extra income'
            : `Plus ${present(totals.additionalIncome).display} extra`,
      },
      { kind: 'goal', value: present(totals.goal).display, note: 'Set at the start of the month' },
      {
        kind: 'saved',
        value: present(totals.saved).display,
        note: `${String(percentage(totals.saved, totals.income))}% of everything that came in`,
      },
      // An em dash rather than a zero: a month with nothing spent has no biggest cost, and `₹0` would
      // read as though something cost nothing.
      biggest === undefined
        ? { kind: 'biggestCost', value: '—' }
        : {
            kind: 'biggestCost',
            value: biggest.name,
            note: `${present(biggest.amount).display} that month`,
          },
      { kind: 'needs', value: present(totals.needs).display, note: 'Rent, bills and food' },
      {
        kind: 'leftOver',
        value: present(totals.net).display,
        note: 'Income minus everything spent',
      },
    ],
  };
}

// ── The archive list ──────────────────────────────────────────────────────────────────────────

export interface ReportsPayload {
  readonly summary: {
    goalsMetLabel: string;
    monthCount: { value: number; display: string };
    averageSpend: DisplayMoney;
    totalSaved: DisplayMoney;
  };
  readonly trend: {
    goalPosition: number;
    bars: {
      monthKey: string;
      label: string;
      fill: number;
      verdict: Verdict;
      percentageLabel: string;
      accessibilityLabel: string;
    }[];
  };
  readonly years: {
    label: string;
    totalSaved: DisplayMoney;
    months: {
      monthKey: string;
      label: string;
      spent: DisplayMoney;
      percentageLabel: string;
      verdict: Verdict;
      segments: { slot: number; share: number }[];
    }[];
  }[];
}

/**
 * Headroom above the tallest bar, so a full bar does not touch the top of the chart.
 *
 * 1.08 is read off the corpus: `reports-inr.json`'s June bar is 0.9259 at ₹22,360 saved, which puts the
 * scale at 24,149 — and 22,360 × 1.08 is 24,149.
 */
const TREND_HEADROOM = 1.08;

/**
 * Where the goal line sits when there are **no bars at all**. From `reports-empty.json`.
 *
 * With nothing to scale against, the chart is just a goal line, and scaling it against itself would put it
 * at 1/1.08 — very nearly the top, which reads as a mistake. 0.8 leaves headroom that looks deliberate.
 */
const EMPTY_GOAL_POSITION = 0.8;

/**
 * Build the archive list.
 *
 * **The bars carry no figure the client could threshold** (defect D11): no `saved`, no `goal`, and the
 * percentage only as a rendered string. The verdict arrives decided, from one table, server-side.
 */
export function buildReports(
  archives: readonly MonthArchive[],
  user: User,
  rates: RateSet | undefined,
): ReportsPayload {
  const currency = user.displayCurrency;
  const zero = money(0, currency);

  // Oldest first for the trend chart, newest first for the year list — two orderings of one archive.
  const oldestFirst = [...archives].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const rows = oldestFirst.map((archive) => ({
    archive,
    totals: totalsOf(archive, currency, rates),
  }));

  const totalSaved = sum(rows.map((row) => row.totals.saved), currency);
  const totalSpent = sum(rows.map((row) => row.totals.spent), currency);
  const goalsMet = rows.filter((row) => row.archive.verdict === 'hit').length;

  const goal = convert(user.savingsGoal, currency, rates);
  const tallest = Math.max(0, ...rows.map((row) => row.totals.saved.minor), goal.minor);
  const scale = tallest * TREND_HEADROOM;

  const years = new Map<string, typeof rows>();
  for (const row of rows) {
    const year = yearOf(row.archive.monthKey);
    years.set(year, [...(years.get(year) ?? []), row]);
  }

  return {
    summary: {
      goalsMetLabel:
        rows.length === 0
          ? 'No months have closed yet'
          : `Goal met in ${String(goalsMet)} of ${String(rows.length)} months`,
      monthCount: { value: rows.length, display: String(rows.length) },
      averageSpend: present(
        rows.length === 0 ? zero : { ...zero, minor: Math.round(totalSpent.minor / rows.length) },
      ),
      totalSaved: present(totalSaved),
    },

    trend: {
      // Keyed on there being no bars, not on a zero scale: a reader with a goal and no closed months has a
      // non-zero scale and still nothing to compare against.
      goalPosition:
        rows.length === 0 || scale === 0
          ? EMPTY_GOAL_POSITION
          : Math.round((goal.minor / scale) * 10_000) / 10_000,
      bars: rows.map((row) => ({
        monthKey: row.archive.monthKey,
        label: monthName(row.archive.monthKey).slice(0, 3),
        fill: scale === 0 ? 0 : Math.round((row.totals.saved.minor / scale) * 10_000) / 10_000,
        verdict: row.archive.verdict,
        percentageLabel: `${String(percentage(row.totals.saved, row.totals.goal))}% of goal`,
        accessibilityLabel: `${monthName(row.archive.monthKey)} ${yearOf(row.archive.monthKey)}, ${String(
          percentage(row.totals.saved, row.totals.goal),
        )}% of goal, ${present(row.totals.saved).display} saved`,
      })),
    },

    years: [...years.entries()]
      // Newest year first, and newest month first inside it — the order the list is drawn in.
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([label, yearRows]) => ({
        label,
        totalSaved: present(sum(yearRows.map((row) => row.totals.saved), currency)),
        months: [...yearRows]
          .sort((a, b) => b.archive.monthKey.localeCompare(a.archive.monthKey))
          .map((row) => ({
            monthKey: row.archive.monthKey,
            label: monthName(row.archive.monthKey),
            spent: present(row.totals.spent),
            percentageLabel: `${String(percentage(row.totals.saved, row.totals.goal))}% of goal`,
            verdict: row.archive.verdict,
            segments: HOME_CATEGORY_SLOTS.map((slot) => ({
              slot: slot.slot,
              share: shareOf(row.totals.byCategory[slot.id], row.totals.spent),
            })),
          })),
      })),
  };
}

/** Re-exported so the rollover job and the seed script share one icon rule for carried-forward lines. */
export { utilityIconFor, verdictFor };
