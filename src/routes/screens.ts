import { Hono } from 'hono';

import { getContent, resolveLanguage, type Language } from '../content';
import { computeBudget } from '../domain/budget';
import { convert, present } from '../domain/money';
import { currentStreak, nextLesson } from '../domain/learn';
import { dayKey, monthKey } from '../domain/time';
import { requireSession } from '../middleware/auth';
import { entriesForMonth } from '../repositories/expenseEntries';
import { forUser as fixedCostsForUser } from '../repositories/fixedCosts';
import { asProgress, forUser as learnProgressForUser } from '../repositories/learnProgress';
import { latestRateSet } from '../repositories/fxRates';
import type { User } from '../repositories/users';
import { liveMonthFor } from './expenses';
import { asMonthSpending, monthTotals } from '../screens/expenses';
import { buildHome, type LearnStanding, type MonthSpending } from '../screens/home';
import { money } from '../types/money';
import type { AppEnv } from '../types/hono';

/**
 * The screen endpoints — one request per screen, everything on it computed (ADR-0020).
 *
 * **None of this is cacheable** (invariant 8). Every response is per-user, so each carries
 * `Cache-Control: no-store`, and the Cloudflare cache rules bypass `/v1/screens/*` entirely. A HIT here
 * would be one person's salary served to another.
 *
 * The month's spending comes from `monthTotals` in `screens/expenses.ts` — **the same function the Expenses
 * screen reads**, which is what makes the two agree about the same month. The prototype computed a month's
 * totals separately on each screen, which is defect D1's mechanism.
 *
 * The reader's Learn standing is still supplied as **empty** until slice 5 fills it; the seam is
 * `LearnStanding`, so that slice changes what is passed in rather than how Home is built.
 */

export const screenRoutes = new Hono<AppEnv>();

/**
 * The reader's Learn standing, for Home's learning card.
 *
 * The streak is evaluated lazily against the stored day key here exactly as it is on the Learn screen, so
 * the two cannot disagree — which they would if Home read the stored checkpoint directly.
 */
async function learningFor(user: User, now: Date, language: Language): Promise<LearnStanding> {
  const stored = await learnProgressForUser(user._id);
  const progress = asProgress(stored);
  const curriculum = getContent(language).curriculum.value;
  const next = nextLesson(curriculum, progress.done);

  return {
    streak: currentStreak(progress.streak, progress.lastActiveDayKey, dayKey(now, user.timezone)),
    xp: progress.xp,
    nextLessonTitle: next?.lesson.title,
  };
}

/**
 * The live month's spending for a user, in their display currency.
 *
 * Shared by Home and `/v1/budget` so that all three surfaces — plus Expenses, which reads the same function
 * — describe one month identically.
 */
async function spendingFor(user: User, now: Date): Promise<{ spending: MonthSpending; rates: Awaited<ReturnType<typeof latestRateSet>> }> {
  const [live, rates] = await Promise.all([liveMonthFor(user, now), latestRateSet()]);
  const [monthEntries, fixed] = await Promise.all([
    entriesForMonth(user._id, live),
    fixedCostsForUser(user._id, user.displayCurrency),
  ]);

  const totals = monthTotals(monthEntries, fixed, user.displayCurrency, rates);
  return { spending: asMonthSpending(totals), rates };
}

/**
 * `GET /v1/screens/home`.
 *
 * Reads the user document once — which is where the salary lives, and the whole of defect D1's fix —
 * plus the newest rate set, and builds the entire screen from them.
 *
 * The rate set is fetched even when it is not needed, because whether it *is* needed depends on the
 * user's display currency versus every authored currency in the month, and one extra indexed read is
 * cheaper than discovering halfway through that a conversion cannot be done. It is `undefined`-tolerant:
 * a reader whose display currency is the one they authored in needs no rates at all, which is what lets
 * Home work before an FX provider exists.
 */
screenRoutes.get('/v1/screens/home', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');

  const user = c.var.user;
  const now = new Date();
  const language = resolveLanguage(c.req.header('accept-language'));
  const [{ spending, rates }, learning] = await Promise.all([
    spendingFor(user, now),
    learningFor(user, now, language),
  ]);

  return c.json(buildHome({ user, now, rates, spending, learning, language }));
});

/**
 * `GET /v1/budget` — the budget engine's **only** exposure point (invariant 3).
 *
 * **No screen reads it any more** (iOS ADR-0020): Home, Expenses and Reports all get their figures
 * computed inside their own payloads, because a screen that composes four responses is a screen that
 * derives the join. It stays because the invariant names one exposure point for the engine, and because
 * it is the endpoint that makes the engine's output inspectable without a screen in the way — which is
 * what `budget-inr.json` and `budget-aed.json` describe.
 */
screenRoutes.get('/v1/budget', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');

  const user = c.var.user;
  const now = new Date();
  const currency = user.displayCurrency;
  const { spending, rates } = await spendingFor(user, now);

  const salary = convert(user.salary, currency, rates);
  const goal = convert(user.savingsGoal, currency, rates);

  // needs = rent + utilities + groceries; wants = transport + entertainment + other (DATA_MODEL §2).
  const amountOf = (id: keyof typeof spending.byCategory): typeof goal =>
    spending.byCategory[id] ?? money(0, currency);
  const budget = computeBudget({
    income: { ...salary, minor: salary.minor + spending.additionalIncome.minor },
    needs: {
      ...goal,
      minor: amountOf('rent').minor + amountOf('utilities').minor + amountOf('groceries').minor,
    },
    wantsSpent: {
      ...goal,
      minor: amountOf('transport').minor + amountOf('entertainment').minor + amountOf('other').minor,
    },
    goal,
  });

  return c.json({
    month: monthKey(now, user.timezone),
    currency,
    income: present(budget.income),
    needs: present(budget.needs),
    wantsSpent: present(budget.wantsSpent),
    wantsAllowance: present(budget.wantsAllowance),
    savingsAllowance: present(budget.savingsAllowance),
    adapted: budget.adapted,
    saved: present(budget.saved),
    net: present(budget.net),
    overspent: budget.overspent,
    surplus: present(budget.surplus),
    verdict: budget.verdict,
  });
});

/**
 * `GET /v1/fx/rates` — the newest rate set and the day it is for.
 *
 * **Cacheable** (invariant 8 names `/v1/fx/rates` among the three cacheable families): it is the same
 * rates for everybody. Short-lived, because a set is written daily and a reader holding yesterday's
 * would convert against stale rates.
 *
 * `404` when nothing has been written yet, rather than an empty set: an empty rate table is the rate-1.0
 * fallback in disguise (defect D15), and a caller must be able to tell "no rates" from "these rates".
 */
screenRoutes.get('/v1/fx/rates', async (c) => {
  const rates = await latestRateSet();
  if (rates === undefined) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'No FX rate set has been published yet' } },
      404,
    );
  }

  c.header('Cache-Control', 'public, max-age=900, must-revalidate');
  return c.json({ dateKey: rates.dateKey, base: rates.base, rates: rates.rates });
});
