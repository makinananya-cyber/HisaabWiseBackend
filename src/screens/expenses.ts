import { computeBudget } from '../domain/budget';
import { convert, currencyToken, present, sum, type DisplayMoney, type RateSet } from '../domain/money';
import { dayKey, relativeDayLabel } from '../domain/time';
import type { ExpenseEntry, LogCategory } from '../repositories/expenseEntries';
import type { FixedCosts } from '../repositories/fixedCosts';
import type { User } from '../repositories/users';
import { money, type Money } from '../types/money';
import type { HomeCategoryId, MonthSpending } from './home';

/**
 * `GET /v1/screens/expenses` — **the single read Expenses makes** (ADR-0020).
 *
 * The monthly summary and its three-way split, the wants-bar state, every per-category running total, and
 * each entry's "Today / Yesterday / N days ago" label all arrive computed. The client sums nothing and owns
 * no calendar — which is the fix for defect D5, where the design derived its date labels from the device
 * clock in the browser.
 *
 * This module is also where **Home's spending comes from**. `monthSpending` below is the one function that
 * turns a month's entries and fixed costs into per-category totals, and both screens read it, so the two
 * cannot disagree about the same month. That was defect D1's mechanism, and one function is the fix.
 */

// ── The taxonomy ──────────────────────────────────────────────────────────────────────────────

/**
 * Seven categories in three kinds, in the order the Expenses screen draws them.
 *
 * Transcribed from the design's `CATS`, including the `hint` copy and the `field` each entry form shows.
 * **The order differs from Home's** — Expenses leads with what the reader logs most and puts the two fixed
 * costs last; Home's donut leads with Rent because it is the biggest slice. Both orders are the design's.
 *
 * `kind` decides which collection holds the data and which endpoint writes it:
 *  - `log` — append-only, many entries, each individually deletable (`expense_entries`)
 *  - `lines` — a named set edited in place, carried forward at rollover (`fixed_costs.utilityLines`)
 *  - `fixed` — one amount edited in place, carried forward at rollover (`fixed_costs.rent`)
 */
export const CATEGORIES = [
  {
    id: 'groceries',
    name: 'Groceries',
    hint: 'Add each shop as you go',
    kind: 'log',
    flow: 'out',
    icon: 'groceries',
    field: undefined,
  },
  {
    id: 'transport',
    name: 'Transport',
    hint: 'Pick how you travelled',
    kind: 'log',
    flow: 'out',
    icon: 'transport',
    field: 'transportMode',
  },
  {
    id: 'entertainment',
    name: 'Entertainment',
    hint: 'Nights out, films, events',
    kind: 'log',
    flow: 'out',
    icon: 'entertainment',
    field: 'place',
  },
  {
    id: 'other',
    name: 'Other',
    hint: 'Everything else',
    kind: 'log',
    flow: 'out',
    icon: 'other',
    field: 'otherType',
  },
  {
    id: 'income',
    name: 'Additional Income',
    hint: 'Money coming in',
    kind: 'log',
    flow: 'in',
    icon: 'income',
    field: 'source',
  },
  {
    id: 'utilities',
    name: 'Utilities',
    hint: 'Fixed each month',
    kind: 'lines',
    flow: 'out',
    icon: 'utilities',
    field: undefined,
  },
  {
    id: 'rent',
    name: 'Rent',
    hint: 'Fixed each month',
    kind: 'fixed',
    flow: 'out',
    icon: 'rent',
    field: undefined,
  },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];

export const categoryById = new Map(CATEGORIES.map((category) => [category.id, category] as const));

/** **needs** = rent + utilities + groceries; **wants** = transport + entertainment + other. */
export const NEEDS_CATEGORIES = ['rent', 'utilities', 'groceries'] as const;
export const WANTS_CATEGORIES = ['transport', 'entertainment', 'other'] as const;

/**
 * An icon for a utility line the reader named themselves.
 *
 * The design seeds three lines with icons (`bolt`, `drop`, `signal`) but the client's `BillLine` write
 * carries only a name and an amount — so the icon has to be derived. Keyword matching, defaulting to
 * `tag`, which is exactly what the client's `Icon` decoder falls back to for an unknown value.
 *
 * Deliberately shallow: guessing wrong costs a slightly odd glyph, and a deeper classifier would be a
 * language-specific rule in a system that is about to be translated.
 */
export function utilityIconFor(name: string): string {
  const lowered = name.toLowerCase();
  if (/electric|power|dewa|sewa|light/.test(lowered)) return 'bolt';
  if (/water|gas|sewer/.test(lowered)) return 'drop';
  if (/phone|mobile|data|internet|wifi|du\b|etisalat|broadband/.test(lowered)) return 'signal';
  return 'tag';
}

// ── Month spending, the shared reader ─────────────────────────────────────────────────────────

/** Everything a month amounts to, in the reader's display currency, exact. */
export interface MonthTotals {
  readonly byCategory: Record<CategoryId, Money>;
  /** Per-category entries, converted, with their labels. Only `log` categories have any. */
  readonly entriesByCategory: Record<LogCategory, { entry: ExpenseEntry; amount: Money }[]>;
  readonly utilityLines: { id: string; name: string; amount: Money }[];
  readonly needs: Money;
  readonly wantsSpent: Money;
  readonly additionalIncome: Money;
  /** Rent + utilities — the "fixed" half of the summary's three-way split. */
  readonly fixed: Money;
  /** The four outgoing `log` categories — the "variable" half. */
  readonly variable: Money;
  /** All outgoing spend: fixed + variable. */
  readonly totalOut: Money;
  /** Whether the month has nothing in it at all. */
  readonly isEmpty: boolean;
}

/**
 * Turn a month's raw entries and fixed costs into totals in the reader's currency.
 *
 * **The one place a month is added up.** Home, Expenses and Reports all come through here, which is what
 * makes them agree — and every value is converted to the display currency *exactly* before being summed, so
 * a total is never the sum of rounded parts (Product Spec §4.1).
 */
export function monthTotals(
  entries: readonly ExpenseEntry[],
  fixed: FixedCosts,
  displayCurrency: string,
  rates: RateSet | undefined,
): MonthTotals {
  const inCurrency = (amount: Money): Money => convert(amount, displayCurrency, rates);
  const zero = money(0, displayCurrency);

  // Typed up front rather than with `satisfies`, which infers `never[]` for the keys after the first.
  const entriesByCategory: Record<LogCategory, { entry: ExpenseEntry; amount: Money }[]> = {
    groceries: [],
    transport: [],
    entertainment: [],
    other: [],
    income: [],
  };

  for (const entry of entries) {
    entriesByCategory[entry.category].push({ entry, amount: inCurrency(entry.amount) });
  }

  const utilityLines = fixed.utilityLines.map((line) => ({
    id: line.id,
    name: line.name,
    amount: inCurrency(line.amount),
  }));

  const totalOf = (category: LogCategory): Money =>
    sum(
      entriesByCategory[category].map((row) => row.amount),
      displayCurrency,
    );

  const byCategory: Record<CategoryId, Money> = {
    groceries: totalOf('groceries'),
    transport: totalOf('transport'),
    entertainment: totalOf('entertainment'),
    other: totalOf('other'),
    income: totalOf('income'),
    utilities: sum(
      utilityLines.map((line) => line.amount),
      displayCurrency,
    ),
    rent: inCurrency(fixed.rent),
  };

  const needs = sum(
    NEEDS_CATEGORIES.map((id) => byCategory[id]),
    displayCurrency,
  );
  const wantsSpent = sum(
    WANTS_CATEGORIES.map((id) => byCategory[id]),
    displayCurrency,
  );
  const fixedTotal = sum([byCategory.rent, byCategory.utilities], displayCurrency);
  const variable = sum(
    [byCategory.groceries, byCategory.transport, byCategory.entertainment, byCategory.other],
    displayCurrency,
  );

  return {
    byCategory,
    entriesByCategory,
    utilityLines,
    needs,
    wantsSpent,
    additionalIncome: byCategory.income,
    fixed: fixedTotal,
    variable,
    totalOut: sum([fixedTotal, variable], displayCurrency),
    isEmpty:
      entries.length === 0 && fixed.utilityLines.length === 0 && fixed.rent.minor === 0 && zero.minor === 0,
  };
}

/** The projection Home needs. One function feeds both screens, so they cannot disagree. */
export function asMonthSpending(totals: MonthTotals): MonthSpending {
  const byCategory: Partial<Record<HomeCategoryId, Money>> = {
    rent: totals.byCategory.rent,
    groceries: totals.byCategory.groceries,
    transport: totals.byCategory.transport,
    utilities: totals.byCategory.utilities,
    entertainment: totals.byCategory.entertainment,
    other: totals.byCategory.other,
  };
  return { byCategory, additionalIncome: totals.additionalIncome };
}

// ── The payload ───────────────────────────────────────────────────────────────────────────────

export interface ExpensesPayload {
  readonly monthLabel: string;
  readonly summary: {
    readonly total: DisplayMoney;
    readonly fixed: DisplayMoney;
    readonly variable: DisplayMoney;
    readonly income: DisplayMoney;
  };
  readonly wants: {
    readonly used: DisplayMoney;
    readonly allowance: DisplayMoney;
    readonly percentageLabel: string;
    readonly fill: number;
    readonly isOver: boolean;
  };
  readonly entry: {
    readonly code: string;
    readonly symbol: string;
    readonly displayCode: string;
    readonly exponent: number;
  };
  readonly categories: {
    readonly id: string;
    readonly name: string;
    readonly hint: string;
    readonly total: DisplayMoney;
    readonly entryCountLabel?: string;
    readonly kind: string;
    readonly flow: string;
    readonly icon: string;
    readonly field?: string;
    readonly entries?: { id: string; label: string; amount: DisplayMoney; dateLabel: string }[];
    readonly lines?: { id: string; name: string; amount: DisplayMoney; icon: string }[];
  }[];
}

export interface ExpensesInput {
  readonly user: User;
  readonly now: Date;
  readonly monthLabel: string;
  readonly totals: MonthTotals;
  readonly rates: RateSet | undefined;
}

/** `"2 entries"`, `"1 entry"`, `"0 entries"` — pluralised here because the client prints it verbatim. */
export const entryCountLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? 'entry' : 'entries'}`;

/**
 * Build the Expenses payload.
 *
 * The wants bar is the interesting part: `allowance` comes from the **budget engine**, not from a local
 * 30%-of-salary calculation, so it includes additional income exactly as Home's does (the O1 resolution).
 * `expenses-inr.json`'s allowance of ₹19,770 is 30% of ₹65,900 — salary plus ₹900 of freelance income —
 * which is the fixture confirming it.
 */
export function buildExpenses(input: ExpensesInput): ExpensesPayload {
  const { user, now, monthLabel, totals, rates } = input;
  const currency = user.displayCurrency;
  const today = dayKey(now, user.timezone);

  const salary = convert(user.salary, currency, rates);
  const budget = computeBudget({
    income: { ...salary, minor: salary.minor + totals.additionalIncome.minor },
    needs: totals.needs,
    wantsSpent: totals.wantsSpent,
    goal: convert(user.savingsGoal, currency, rates),
  });

  const token = currencyToken(currency);

  return {
    monthLabel,

    summary: {
      total: present(totals.totalOut),
      fixed: present(totals.fixed),
      variable: present(totals.variable),
      income: present(totals.additionalIncome),
    },

    wants: {
      used: present(totals.wantsSpent),
      allowance: present(budget.wantsAllowance),
      percentageLabel: `${String(percentageOf(totals.wantsSpent, budget.wantsAllowance))}%`,
      // Capped at 1: the bar is full at the allowance and `isOver` is what says it went past. An
      // uncapped fill would draw outside its track.
      fill: fillOf(totals.wantsSpent, budget.wantsAllowance),
      isOver: totals.wantsSpent.minor > budget.wantsAllowance.minor,
    },

    /**
     * What the entry form authors in. `symbol` is the token the money field prefixes; `displayCode` is the
     * code shown beside it. Both come from the same rule as every `display` string, so the form and the
     * figures it produces cannot disagree about what currency this is.
     */
    entry: {
      code: currency,
      symbol: token,
      displayCode: currency,
      exponent: money(0, currency).exponent,
    },

    categories: CATEGORIES.map((category) => {
      const total = totals.byCategory[category.id];
      const base = {
        id: category.id,
        name: category.name,
        hint: category.hint,
        // Additional income reads `+₹900`: it is the only inbound category, and without the sign a
        // reader has no way to tell it from an expense of the same size.
        total: category.flow === 'in' ? withPlus(present(total)) : present(total),
        kind: category.kind,
        flow: category.flow,
        icon: category.icon,
        ...(category.field === undefined ? {} : { field: category.field }),
      };

      if (category.kind === 'log') {
        // Narrowed by `kind`, which the `as const` table ties to the id — the five `log` ids are exactly
        // the five `LogCategory` values.
        const rows = totals.entriesByCategory[category.id];
        return {
          ...base,
          // Only `log` categories carry a count. A fixed cost has no entries to count, and the client's
          // field is optional for exactly that reason.
          entryCountLabel: entryCountLabel(rows.length),
          entries: rows.map((row) => ({
            id: row.entry._id,
            label: row.entry.label,
            amount: present(row.amount),
            dateLabel: relativeDayLabel(dayKey(row.entry.entryDate, user.timezone), today),
          })),
        };
      }

      if (category.kind === 'lines') {
        return {
          ...base,
          lines: totals.utilityLines.map((line) => ({
            id: line.id,
            name: line.name,
            amount: present(line.amount),
            icon: utilityIconFor(line.name),
          })),
        };
      }

      return base;
    }),
  };
}

/** A percentage against an allowance, where a zero allowance means nothing is permitted, so 0%. */
function percentageOf(used: Money, allowance: Money): number {
  // Not money.ts's `percentage`, which answers 100 for a zero denominator — correct for a savings goal
  // (nothing to miss) and wrong here (no allowance means no room, not full room).
  if (allowance.minor === 0) return used.minor > 0 ? 100 : 0;
  return Math.round((used.minor / allowance.minor) * 100);
}

function fillOf(used: Money, allowance: Money): number {
  if (allowance.minor === 0) return used.minor > 0 ? 1 : 0;
  return Math.min(1, Math.round((used.minor / allowance.minor) * 10_000) / 10_000);
}

/** `AED 900` → `+AED 900`, `₹900` → `+₹900`. The sign goes outside the token, as the fixture has it. */
const withPlus = (amount: DisplayMoney): DisplayMoney => ({ ...amount, display: `+${amount.display}` });
