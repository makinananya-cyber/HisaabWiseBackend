import { Hono } from 'hono';

import { resolveLanguage } from '../content';
import { computeBudget } from '../domain/budget';
import { convert, present } from '../domain/money';
import { monthKey } from '../domain/time';
import { requireSession } from '../middleware/auth';
import { latestRateSet } from '../repositories/fxRates';
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
 * Slice 3 lands Home and `GET /v1/budget`. The month's spending and the reader's Learn standing are
 * supplied as **empty** until slices 4 and 5 fill them, which is not a stub: a user who has just
 * registered genuinely has no expenses and no XP, and `home-first-run.json` is that exact state. The
 * seam is `MonthSpending` and `LearnStanding`, so those slices change what is passed in rather than how
 * Home is built.
 */

export const screenRoutes = new Hono<AppEnv>();

/**
 * A month with nothing in it.
 *
 * Named rather than inlined so the two slices that replace it can find every call site, and so this
 * reads as "no data yet" rather than as an accidental zero.
 */
const noSpending = (currency: string): MonthSpending => ({
  byCategory: {},
  additionalIncome: money(0, currency),
});

const noLearning: LearnStanding = { streak: 0, xp: 0, nextLessonTitle: undefined };

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

  return c.json(
    buildHome({
      user,
      now,
      rates: await latestRateSet(),
      spending: noSpending(user.displayCurrency),
      learning: noLearning,
      language: resolveLanguage(c.req.header('accept-language')),
    }),
  );
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
  const rates = await latestRateSet();
  const currency = user.displayCurrency;

  const spending = noSpending(currency);
  const salary = convert(user.salary, currency, rates);
  const goal = convert(user.savingsGoal, currency, rates);

  const budget = computeBudget({
    income: { ...salary, minor: salary.minor + spending.additionalIncome.minor },
    needs: money(0, currency),
    wantsSpent: money(0, currency),
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
