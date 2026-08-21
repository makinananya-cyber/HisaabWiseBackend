import { Hono } from 'hono';
import { z } from 'zod';

import { isWantsShare } from '../domain/budget';
import { isValidTimezone } from '../domain/time';
import { ApiError } from '../errors';
import { requireSession } from '../middleware/auth';
import * as users from '../repositories/users';
import type { AppEnv } from '../types/hono';
import { PREFERENCE_LANGUAGES, resolveLanguage } from '../content';
import { currentExpenses } from './expenses';

/**
 * The identity routes — who the user is, and the preferences that are not any one screen's business.
 *
 * **Not screen endpoints** (ADR-0020). `GET /v1/me` carries who the user is, not what any screen draws:
 * no salary, no display currency, no derived percentage. Duplicating those here would give invariant 2's
 * single owner a second copy that a stale foreground revalidation could disagree with.
 *
 * Three routes the client calls on this path are **not here** — `PUT /v1/me`, `PUT /v1/me/currency` and
 * `POST /v1/me/password`. All three answer with the **Account screen payload** (ADR-0020), so they land
 * with slice 7, which is where that payload is built. Their security mechanisms are slice 2's and are
 * already in place: `users.setPassword` bumps `securityEpoch`, and `refreshTokens.revokeOtherFamilies`
 * is what a password change calls.
 */

export const meRoutes = new Hono<AppEnv>();

/**
 * `GET /v1/me` — the identity revalidation the client performs on foreground.
 *
 * `emailVerified` is always `true`: nothing is verified out of band and recovery is by security question
 * (BACKEND_PLAN §4.2.1, §4.2.2). The field stays in the contract because the client threads it through
 * `Session`, `AccountScreen`, `AccountView` and the unverified banner — roughly fifty references and two
 * fixtures — and removing the concept would be an iOS change and a fixture change for no functional
 * gain. The banner never fires, and the field is already there if verification is ever wanted.
 *
 * **Never cached, at the edge or anywhere else.** A cache HIT on this response is one user's email
 * address served to another (invariant 8).
 */
meRoutes.get('/v1/me', requireSession(), (c) => {
  const user = c.var.user;
  c.header('Cache-Control', 'no-store');

  return c.json({
    email: user.email,
    displayName: user.displayName,
    // Literally `true`, not derived from a nullable timestamp — `emailVerifiedAt` is set at
    // registration and there is no path that clears it. Writing `emailVerifiedAt !== null` would
    // dress a constant up as a computation and imply a false case that does not exist.
    emailVerified: true,
  });
});

/**
 * `PUT /v1/me/language` — the stored language preference.
 *
 * **A route the client invented, and it earns its place** (iOS ADR-0024). `Accept-Language` tells the
 * server what to format *this* response in and nothing about a push notification composed six hours
 * later, so the preference has to be stored as well as sent.
 *
 * Answers with the language, which is the field the client reads. Slice 7 widens this to the full Account
 * screen payload; the client's decoder reads its one field out of a wider body and ignores the rest, so
 * that widening is not a breaking change.
 *
 * A `PUT` because it replaces a value, so it carries no `Idempotency-Key`.
 */
meRoutes.put('/v1/me/language', requireSession(), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = z.object({ language: z.enum(PREFERENCE_LANGUAGES) }).safeParse(raw);
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED');

  c.header('Cache-Control', 'no-store');
  await users.setLanguage(c.var.user._id, parsed.data.language);
  return c.json({ language: parsed.data.language });
});

/**
 * `PUT /v1/me/timezone` — the stored IANA zone.
 *
 * **The client does not call this**, and that is by design: the zone is captured on registration, login
 * and refresh (ADR-0023), which covers every moment the app has a fresh one to report. The route exists
 * for the case those three do not cover — a long-lived session whose user has moved and whose access
 * token has not yet expired — and because invariant 6 makes the stored zone load-bearing enough that
 * there should be a way to correct it without signing out.
 *
 * Validated, not trusted: a stored zone this runtime cannot resolve would make every subsequent day-key
 * lookup throw, and the failure would surface days later on somebody's Expenses screen.
 */
meRoutes.put('/v1/me/timezone', requireSession(), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = z
    .object({ timeZone: z.string().min(1).refine(isValidTimezone) })
    .safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', undefined, {
      timeZone: 'not an IANA timezone this server recognises',
    });
  }

  c.header('Cache-Control', 'no-store');
  await users.setTimezone(c.var.user._id, parsed.data.timeZone);
  return c.json({ timeZone: parsed.data.timeZone });
});

/**
 * `PUT /v1/me/budget/wants` — the share of income the wants allowance is taken from (domain `budget.ts`).
 *
 * **One number, and it is a *setting* rather than an amount.** The 50/30/20 split ships as the default and
 * the reader moves the middle figure here: what crosses the wire is the percentage they chose, never an
 * allowance — the engine takes its share of income server-side, so §4.2 still has exactly one owner
 * (invariant 3). A client that sent a figure would be computing the budget, which is defect D11's shape.
 *
 * It is `/v1/me/…` rather than `/v1/expenses/…` because it belongs to the *user*, not the month: it
 * survives the rollover, and Home and Reports read allowances derived from it too. It **answers with the
 * Expenses screen payload** all the same (ADR-0020), because Expenses is the screen the reader set it from —
 * so the wants bar, its `sharePercent`, and the per-share amounts all come back recomputed in one response.
 *
 * The updated user is assembled in place rather than re-read: the only field that changed is the one just
 * written, so a round trip to the collection would buy nothing.
 */
meRoutes.put('/v1/me/budget/wants', requireSession(), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = z.object({ percent: z.number().int() }).safeParse(raw);
  if (!parsed.success || !isWantsShare(parsed.data.percent)) {
    throw new ApiError('VALIDATION_FAILED', 'the wants share must be one of 10, 15, 20, 25, 30, 35 or 40', {
      percent: 'must be a whole percent between 10 and 40 in steps of five',
    });
  }

  await users.setWantsShare(c.var.user._id, parsed.data.percent);

  c.header('Cache-Control', 'no-store');
  const user = { ...c.var.user, wantsSharePercent: parsed.data.percent };
  const language = resolveLanguage(c.req.header('accept-language'));
  return c.json(await currentExpenses(user, new Date(), language));
});
