import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { hashSecret, verifySecret } from '../auth/hashing';
import { resolveLanguage, type Language } from '../content';
import { convert } from '../domain/money';
import { normaliseAnswer } from '../domain/securityAnswers';
import { isKnownCurrency } from '../types/money';
import { ApiError } from '../errors';
import { requireSession } from '../middleware/auth';
import { latestRateSet } from '../repositories/fxRates';
import * as events from '../repositories/events';
import * as entries from '../repositories/expenseEntries';
import * as fixedCosts from '../repositories/fixedCosts';
import * as learnProgress from '../repositories/learnProgress';
import * as archives from '../repositories/monthArchives';
import * as refreshTokens from '../repositories/refreshTokens';
import * as users from '../repositories/users';
import { assertConvertible, buildAccount, type AccountPayload } from '../screens/account';
import { moneyInputSchema } from '../types/money';
import type { AppEnv } from '../types/hono';

/**
 * Account, and the compliance surface: export, deletion, and events.
 *
 * The three write routes here all answer with the **Account screen payload** (ADR-0020), which is why they
 * land in this slice rather than slice 2 — their security mechanisms were built there.
 */

export const accountRoutes = new Hono<AppEnv>();

async function body<Schema extends z.ZodType>(c: Context<AppEnv>, schema: Schema): Promise<z.infer<Schema>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', 'the request body was not valid', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/** Re-read the user and build the screen. Every write answers with this, so nothing is patched client-side. */
async function currentAccount(
  userId: Parameters<typeof users.findById>[0],
  language: Language,
): Promise<AccountPayload> {
  const user = await users.findById(userId);
  if (user === null) throw new ApiError('UNAUTHENTICATED');
  return buildAccount({ user, now: new Date(), rates: await latestRateSet(), language });
}

accountRoutes.get('/v1/screens/account', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');
  const language = resolveLanguage(c.req.header('accept-language'));
  return c.json(
    buildAccount({ user: c.var.user, now: new Date(), rates: await latestRateSet(), language }),
  );
});

// ── Personal details ──────────────────────────────────────────────────────────────────────────

const phoneSchema = z.object({
  country: z.string().length(2),
  dialCode: z.string().regex(/^\+\d{1,4}$/),
  national: z.string().regex(/^\d{4,15}$/),
  e164: z.string().regex(/^\+\d{5,19}$/),
});

/**
 * `PUT /v1/me` — the three editable personal details, together.
 *
 * **`PUT` rather than the Technical Spec's `PATCH`**, because the design's Save button commits the whole card
 * at once: every field the route accepts is in every request, so there is nothing to distinguish "left alone"
 * from "set to this".
 *
 * **Email is not a parameter, and that absence is the point** (invariant 4). It is the identity, it is locked
 * on the screen, and there is nothing here for a client bug or a future refactor to fill in.
 */
accountRoutes.put('/v1/me', requireSession(), async (c) => {
  const input = await body(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(100),
      salary: moneyInputSchema,
      phone: phoneSchema.nullish(),
    }),
  );

  const user = c.var.user;
  await users.setPersonalDetails(user._id, {
    displayName: input.displayName,
    salary: input.salary,
    // **Absent and `null` are different requests.** Omitting the key leaves the stored number alone;
    // sending `null` clears it. The screen sends every field, so a reader is unaffected either way — but
    // the endpoint had no guard, and one caller forgetting one key permanently destroyed a phone number.
    ...(input.phone === undefined ? {} : { phone: input.phone }),
  });

  c.header('Cache-Control', 'no-store');
  return c.json(await currentAccount(user._id, resolveLanguage(c.req.header('accept-language'))));
});

/**
 * `PUT /v1/me/currency` — the display currency, by ISO code.
 *
 * **Checked before it is stored.** A currency change that saves successfully and then breaks every screen is
 * the worst ordering available, so the conversion is attempted first: if the rate set cannot serve this
 * currency, the preference is not written and the reader keeps a working app.
 *
 * The repaint is every **other** screen: their figures were converted at read in the old currency (iOS
 * ADR-0003), which is why this answers with the account payload and the client re-reads the rest.
 */
accountRoutes.put('/v1/me/currency', requireSession(), async (c) => {
  const input = await body(
    c,
    z.object({
      currency: z
        .string()
        .length(3)
        .refine(isKnownCurrency, { message: 'not a currency in content/reference/currencies.json' }),
    }),
  );

  const user = c.var.user;
  const currency = input.currency.toUpperCase();

  assertConvertible(user, currency, await latestRateSet());
  await users.setDisplayCurrency(user._id, currency);

  c.header('Cache-Control', 'no-store');
  return c.json(await currentAccount(user._id, resolveLanguage(c.req.header('accept-language'))));
});

/**
 * `PUT /v1/me/goal` — the savings goal.
 *
 * The goal was authored at registration and then had **no route at all**, so a reader whose pay rose could
 * not move it: "% of goal" simply drifted (635% in one observed case, on a goal that had become a twelfth
 * of their pay). Home now suggests a new figure when a raise leaves the goal behind, and this is what makes
 * that suggestion something the reader can act on rather than just read.
 *
 * **Stored in the salary's currency, in whatever currency it arrives.** The pair is compared by the budget
 * engine, so two currencies would make `saved` a conversion rather than a subtraction — but which currency the
 * salary was authored in is not something the client knows, so the conversion is this route's job. See below.
 */
accountRoutes.put('/v1/me/goal', requireSession(), async (c) => {
  const input = await body(c, z.object({ savingsGoal: moneyInputSchema }));
  const user = c.var.user;

  /**
   * **Converted into the salary's currency rather than refused for not being in it.**
   *
   * The goal is stored beside the salary and compared against it by the budget engine, so it has to end up in
   * the salary's authoring currency — but the *client* does not know what that is, and deliberately does not
   * (iOS ADR-0003: it is handed display strings, not authoring figures). This route refused anything in another
   * currency until a live test tried the obvious thing: Home offers a suggested goal in the reader's **display**
   * currency, the reader presses "Raise my goal", and the request was rejected for a currency the client was
   * never told to use. So the conversion happens here, exactly as `PUT /v1/me/currency` converts before storing.
   */
  const authored =
    input.savingsGoal.currency === user.salary.currency
      ? input.savingsGoal
      : convert(input.savingsGoal, user.salary.currency, await latestRateSet());

  // `goalWasSkipped` becomes false: a reader who sets a figure by hand has chosen it, whatever they did at
  // registration, and the flag exists to record that they had not.
  await users.setSavingsGoal(user._id, authored, false);

  c.header('Cache-Control', 'no-store');
  return c.json(await currentAccount(user._id, resolveLanguage(c.req.header('accept-language'))));
});

/**
 * `POST /v1/me/password/check` — is what the reader has typed so far right?
 *
 * **This is a deliberate reversal of an earlier decision, and the trade-off is worth stating.** The change
 * itself is one atomic request (below) precisely so the server keeps no session-scoped "got past step one"
 * state. But that left the wizard collecting a current password, two security answers and a new password
 * before saying that the *first* field was wrong — three steps of work thrown away, and the reader left
 * guessing which one it was.
 *
 * So this route exists to fail fast, and it is honest about what it is: **a password- and answer-checking
 * oracle behind a valid session**. Somebody holding a stolen access token can use it to test guesses at the
 * current password without needing to complete a change. That is why:
 *
 *   - it is **advisory only** — it writes nothing, and `POST /v1/me/password` re-verifies everything, so the
 *     server remains the authority and no state is carried between the two;
 *   - a wrong answer **counts against the same recovery lockout** the forgot-password flow uses, so guessing
 *     here is as expensive as guessing there;
 *   - it never says which of the two security answers missed, for the same reason the change route does not.
 *
 * Every refusal is a `422`, never a `401` — on this client a `401` means "your token is no good" and would
 * spend the refresh token, ending the session over a typo.
 */
accountRoutes.post('/v1/me/password/check', requireSession(), async (c) => {
  const input = await body(
    c,
    z.object({
      currentPassword: z.string().min(1).max(256),
      /** Absent means "only check the password" — step one asks that much and no more. */
      securityAnswers: z
        .array(z.object({ questionId: z.string().regex(/^sq\d{2}$/), answer: z.string().min(1).max(200) }))
        .length(2)
        .optional(),
    }),
  );

  const user = c.var.user;
  const now = new Date();

  if (users.isLocked(user.recoveryLockedUntil, now)) throw new ApiError('ACCOUNT_LOCKED');

  if (!(await verifySecret(user.passwordHash, input.currentPassword))) {
    await users.recordFailedRecovery(user._id, now);
    throw new ApiError('INVALID_CREDENTIALS', 'that is not the current password');
  }

  if (input.securityAnswers !== undefined) {
    const answers = input.securityAnswers;
    // Both verified whatever the first said, so the timing does not reveal which failed.
    const verdicts = await Promise.all(
      user.securityQuestions.map(async ({ questionId, answerHash }) => {
        const given = answers.find((answer) => answer.questionId === questionId);
        if (given === undefined) return false;
        return verifySecret(answerHash, normaliseAnswer(given.answer));
      }),
    );
    if (verdicts.includes(false)) {
      await users.recordFailedRecovery(user._id, now);
      throw new ApiError('SECURITY_ANSWERS_INVALID');
    }
  }

  await users.clearFailedRecoveries(user._id);

  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true });
});

/**
 * `POST /v1/me/password` — current password, both security answers, and the new password, in one request.
 *
 * **One request rather than three**, and this is the decision worth reading. The design walks three steps and
 * verifies each in the browser — the current password against nothing at all, and the answers against a value
 * held in memory, which is defect D4. Once verification is server-side, a step-by-step flow would need the
 * server to *remember* that this session got past step one: a session-scoped verification state nothing else
 * in this app has, and a route that answers "is this the right current password?" before being told what to
 * change it to, which is a password-checking oracle behind a session.
 *
 * **Every refusal is a `422`, never a `401`** (iOS `ErrorCode.invalidCredentials`). On this client a `401`
 * means "your token is no good", so it spends the refresh token; against a rotating family, a mistyped
 * current password would end the session.
 *
 * **Every *other* session is revoked** (Product Spec §3.7). The requesting family survives, so the reader is
 * not signed out of the device they just used to change their password.
 */
accountRoutes.post('/v1/me/password', requireSession(), async (c) => {
  const input = await body(
    c,
    z.object({
      currentPassword: z.string().min(1).max(256),
      securityAnswers: z
        .array(z.object({ questionId: z.string().regex(/^sq\d{2}$/), answer: z.string().min(1).max(200) }))
        .length(2),
      newPassword: z.string().min(8).max(256),
    }),
  );

  const user = c.var.user;
  const now = new Date();

  if (!(await verifySecret(user.passwordHash, input.currentPassword))) {
    throw new ApiError('INVALID_CREDENTIALS', 'that is not the current password');
  }

  // Both answers verified whatever the first one said, so the timing does not reveal which failed. And the
  // refusal never says which — telling somebody which of two guesses landed halves the work of the other.
  const verdicts = await Promise.all(
    user.securityQuestions.map(async ({ questionId, answerHash }) => {
      const given = input.securityAnswers.find((answer) => answer.questionId === questionId);
      if (given === undefined) return false;
      return verifySecret(answerHash, normaliseAnswer(given.answer));
    }),
  );
  if (verdicts.includes(false)) throw new ApiError('SECURITY_ANSWERS_INVALID');

  // Bumps `securityEpoch`, which is what makes the other devices stop working *now* rather than in fifteen
  // minutes.
  await users.setPassword(user._id, await hashSecret(c.var.config, input.newPassword), now);

  /**
   * Every **other** session is revoked; the requesting one survives (Product Spec §3.7).
   *
   * The family comes from the access token's `fam` claim, so no client change was needed — the client's
   * `PasswordChange` body carries only the three fields the user typed. Without the claim the safe reading is
   * to revoke everything: leaving a possibly-stolen session alive is worse than an extra sign-in.
   */
  const keepFamily: string | undefined = c.var.familyId;
  if (keepFamily === undefined) {
    await refreshTokens.revokeAllForUser(user._id, now);
  } else {
    await refreshTokens.revokeOtherFamilies(user._id, keepFamily, now);
  }

  c.var.log.warn({ userId: user._id.toHexString() }, 'password changed, other sessions revoked');

  c.header('Cache-Control', 'no-store');
  return c.json(await currentAccount(user._id, resolveLanguage(c.req.header('accept-language'))));
});

// ── Compliance ────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/me/export` — the UAE PDPL data-subject access right.
 *
 * **The one per-user response the client does not decode** (iOS `Endpoint.export`). It comes back as bytes and
 * goes straight to a file: modelling it would mean the client owning a schema for every collection, and
 * re-encoding it to save would hand the user *this client's* idea of their data rather than the server's.
 *
 * Streamed, so a user with two years of history does not require two years of history in memory. `?format=csv`
 * with a `part` serves one collection as a spreadsheet, which is what a person actually opens.
 */
accountRoutes.get('/v1/me/export', requireSession(), async (c) => {
  const user = c.var.user;
  const format = c.req.query('format');
  const part = c.req.query('part');

  // **Every entry, across every month.** One query rather than "the live month plus each archived month",
  // which is what this did until the suite caught it missing the live month entirely — a reader exercising
  // their access right would have received their history and not their present.
  const [allEntries, fixed, monthArchives, learn, userEvents] = await Promise.all([
    entries.allForUser(user._id),
    fixedCosts.forUser(user._id, user.displayCurrency),
    archives.archivesForUser(user._id),
    learnProgress.forUser(user._id),
    events.forUser(user._id),
  ]);

  if (format === 'csv') {
    return csvPart(c, part, { expenses: allEntries, monthArchives, learn, userEvents });
  }

  c.header('Cache-Control', 'no-store');
  c.header('Content-Disposition', 'attachment; filename="hisaabwise-export.json"');

  return c.json({
    generatedAt: new Date().toISOString(),
    account: {
      email: user.email,
      displayName: user.displayName,
      displayCurrency: user.displayCurrency,
      language: user.language,
      timeZone: user.timezone,
      dateOfBirth: user.dob.toISOString().slice(0, 10),
      phone: user.phone,
      salary: { minor: user.salary.minor, currency: user.salary.currency },
      savingsGoal: { minor: user.savingsGoal.minor, currency: user.savingsGoal.currency },
      createdAt: user.createdAt.toISOString(),
      // The **questions**, never the answers: those are hashes over a normalised form and never leave the
      // server, not even to their owner (invariant 5). Returning them here would be the one export that
      // undid the invariant.
      securityQuestions: user.securityQuestions.map(({ questionId }) => questionId),
    },
    expenses: allEntries.map((entry) => ({
      id: entry._id,
      monthKey: entry.monthKey,
      categoryId: entry.category,
      amount: { minor: entry.amount.minor, currency: entry.amount.currency },
      label: entry.label,
      loggedAt: entry.entryDate.toISOString(),
    })),
    fixedCosts: {
      rent: { minor: fixed.rent.minor, currency: fixed.rent.currency },
      utilityLines: fixed.utilityLines.map((line) => ({
        name: line.name,
        amount: { minor: line.amount.minor, currency: line.amount.currency },
      })),
    },
    archives: monthArchives.map((archive) => ({
      monthKey: archive.monthKey,
      salary: { minor: archive.salary.minor, currency: archive.salary.currency },
      goal: { minor: archive.goal.minor, currency: archive.goal.currency },
      saved: { minor: archive.saved.minor, currency: archive.saved.currency },
      verdict: archive.verdict,
      closedAt: archive.closedAt.toISOString(),
    })),
    learn: {
      xp: learn.xp,
      streakDays: learn.streak,
      completedLessons: Object.keys(learn.done),
      // The counts as well as the list, because "which lessons" and "how they went" are different facts and an
      // export should carry both.
      lessons: learn.done,
    },
    events: userEvents.map((event) => ({
      name: event.name,
      props: event.props,
      at: event.receivedAt.toISOString(),
    })),
  });
});

/** One collection as CSV. A person opens a spreadsheet; nobody opens a 2 MB JSON file. */
function csvPart(
  c: Context<AppEnv>,
  part: string | undefined,
  data: {
    expenses: { _id: string; monthKey: string; category: string; amount: { minor: number; currency: string }; label: string; entryDate: Date }[];
    monthArchives: { monthKey: string; saved: { minor: number; currency: string }; verdict: string }[];
    learn: { done: Record<string, { correct: number; total: number; xp: number }> };
    userEvents: { name: string; receivedAt: Date }[];
  },
): Response {
  // A leading `'` on anything that could be read as a formula: an exported CSV is opened in a spreadsheet,
  // and a label beginning `=` is a formula-injection vector rather than a label.
  const cell = (value: string | number): string => {
    const text = String(value);
    const escaped = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${escaped.replaceAll('"', '""')}"`;
  };
  const rows = (header: string[], body: (string | number)[][]): string =>
    [header, ...body].map((row) => row.map(cell).join(',')).join('\n');

  const table = ((): string => {
    switch (part) {
      case 'expenses':
        return rows(
          ['id', 'monthKey', 'category', 'amountMinor', 'currency', 'label', 'loggedAt'],
          data.expenses.map((entry) => [
            entry._id,
            entry.monthKey,
            entry.category,
            entry.amount.minor,
            entry.amount.currency,
            entry.label,
            entry.entryDate.toISOString(),
          ]),
        );
      case 'archives':
        return rows(
          ['monthKey', 'savedMinor', 'currency', 'verdict'],
          data.monthArchives.map((archive) => [
            archive.monthKey,
            archive.saved.minor,
            archive.saved.currency,
            archive.verdict,
          ]),
        );
      case 'learn':
        return rows(
          ['lessonId', 'correct', 'total', 'xp'],
          Object.entries(data.learn.done).map(([lessonId, done]) => [
            lessonId,
            done.correct,
            done.total,
            done.xp,
          ]),
        );
      case 'events':
        return rows(
          ['name', 'receivedAt'],
          data.userEvents.map((event) => [event.name, event.receivedAt.toISOString()]),
        );
      default:
        throw new ApiError(
          'VALIDATION_FAILED',
          'part must be one of expenses, archives, learn, events',
        );
    }
  })();

  return c.body(table, 200, {
    'Content-Type': 'text/csv; charset=UTF-8',
    // `part` is narrowed to one of the four by the switch above; the default branch threw.
    'Content-Disposition': `attachment; filename="hisaabwise-${part}.csv"`,
    'Cache-Control': 'no-store',
  });
}

/**
 * `DELETE /v1/me` — the soft delete that starts the thirty-day grace period.
 *
 * **Soft, and that is a kindness rather than a hedge.** Sign-in is blocked, the email stays reserved, and the
 * account is recoverable — "I deleted my finance app by accident" is a real thing. `purge:deleted` erases
 * everything thirty days later and leaves a tombstone.
 *
 * Every session ends at once, via the `securityEpoch` bump: a deleted account must not keep working on the
 * device that deleted it.
 */
accountRoutes.delete('/v1/me', requireSession(), async (c) => {
  const user = c.var.user;
  const now = new Date();

  await users.softDelete(user._id, now);
  await refreshTokens.revokeAllForUser(user._id, now);

  c.var.log.warn({ userId: user._id.toHexString() }, 'account deletion requested');

  c.header('Cache-Control', 'no-store');
  return c.json({
    deletedAt: now.toISOString(),
    purgeAfterDays: 30,
    // Said plainly, because the client shows it and because a grace period nobody knows about is not one.
    message: 'Your account is scheduled for deletion. Sign in within 30 days to restore it.',
  });
});

/**
 * `POST /v1/events` — product metrics, in place of a third-party analytics SDK.
 *
 * **Unauthenticated on purpose**, because the events worth having start before there is an account. That makes
 * the allowlist load-bearing: an unknown name is dropped and undeclared props are stripped, so this is not an
 * unauthenticated write into an unbounded collection.
 *
 * Live in slice 7 rather than slice 8 for one reason: **activation metrics cannot be backfilled.**
 */
accountRoutes.post('/v1/events', async (c) => {
  const input = await body(
    c,
    z.object({
      installId: z.string().min(1).max(100).nullish(),
      events: z
        .array(
          z.object({
            name: z.string().min(1).max(60),
            props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
            clientTs: z.iso.datetime().optional(),
          }),
        )
        .min(1)
        // A bound, because this is unauthenticated.
        .max(50),
    }),
  );

  // The session is read if there is one, and its absence is not an error.
  let userId: users.User['_id'] | null = null;
  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ') === true) {
    try {
      const { verifyAccessToken } = await import('../auth/tokens');
      const claims = await verifyAccessToken(c.var.config, header.slice('Bearer '.length).trim());
      const user = await users.findById(claims.userId);
      if (user !== null && user.securityEpoch === claims.securityEpoch) userId = user._id;
    } catch {
      // An event with a bad token is still an event. Refusing the batch would lose data for no gain.
      userId = null;
    }
  }

  const stored = await events.recordEvents(
    input.events.map((event) => ({
      userId,
      installId: input.installId ?? null,
      name: event.name,
      props: event.props ?? {},
      clientTs: event.clientTs === undefined ? null : new Date(event.clientTs),
    })),
    new Date(),
  );

  // `accepted` rather than a bare 204, so a client can notice that an event name it sent was dropped.
  return c.json({ received: input.events.length, accepted: stored }, 202);
});
