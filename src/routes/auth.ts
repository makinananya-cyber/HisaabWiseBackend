import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { equaliseTiming, hashSecret, verifySecret } from '../auth/hashing';
import { mintAccessToken, refreshTokenExpiry } from '../auth/tokens';
import type { Config } from '../config';
import { getContent } from '../content';
import { normaliseAnswer } from '../domain/securityAnswers';
import { ageInYears, calendarDate, isValidTimezone } from '../domain/time';
import { ApiError } from '../errors';
import { requireSession } from '../middleware/auth';
import { stitchInstall } from '../repositories/events';
import * as refreshTokens from '../repositories/refreshTokens';
import * as passwordResets from '../repositories/passwordResets';
import * as users from '../repositories/users';
import { moneyInputSchema } from '../types/money';
import type { AppEnv } from '../types/hono';

/**
 * Identity. This slice gates every screen, which is why it comes before any of them.
 *
 * Five properties are load-bearing here and each is easy to lose in a refactor:
 *
 *  1. **Registration is atomic.** One `POST` for all three of the client's steps, so there is no
 *     half-built account for every downstream route to defend against (ADR-0004).
 *  2. **An unknown email is indistinguishable from a wrong password** — same code, same status, and the
 *     same argon2 cost paid, so the timing matches too (ADR-0010).
 *  3. **Reuse of a revoked refresh token revokes the whole family** (ADR-0005).
 *  4. **A password change invalidates outstanding access tokens immediately**, via `securityEpoch`.
 *  5. **Security answers are compared as hashes of a normalised form** and never stored or returned raw
 *     (invariant 5).
 *
 * There is deliberately no `check-email` route: it would answer "does this person bank here" to anybody
 * who asked.
 */

// ── Shared shapes ─────────────────────────────────────────────────────────────────────────────

/**
 * The IANA zone the device reported.
 *
 * Validated rather than trusted, because a stored zone this runtime cannot resolve would make every
 * subsequent day-key lookup throw — the failure would surface on the Expenses screen, days later, for
 * one user (invariant 6).
 */
const timezoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimezone, { message: 'not an IANA timezone this server recognises' });

/** 8+ characters, everywhere, with no upper bound below argon2's own (invariant 4). */
const passwordSchema = z.string().min(8).max(256);

const emailSchema = z.email().max(254);

const securityAnswerSchema = z.object({
  questionId: z.string().regex(/^sq\d{2}$/),
  answer: z.string().min(1).max(200),
});

/**
 * Exactly two answers, from two *different* questions in the bank.
 *
 * The distinctness check is not pedantry: two answers to one question is one factor wearing a disguise,
 * and it would halve the strength of the only mechanism that can recover an account.
 */
const securityAnswersSchema = z
  .array(securityAnswerSchema)
  .length(2)
  .refine((answers) => answers[0]?.questionId !== answers[1]?.questionId, {
    message: 'the two security questions must be different',
  })
  .refine(
    (answers) =>
      answers.every(({ questionId }) =>
        getContent().securityQuestions.value.questions.some((q) => q.id === questionId),
      ),
    { message: 'not a question in content/security-questions.en.json' },
  )
  .refine((answers) => answers.every(({ answer }) => normaliseAnswer(answer).length > 0), {
    // An answer of "the" or "??" normalises to nothing, and hashing nothing would store an answer that
    // any other empty answer matches.
    message: 'an answer must contain at least one identifying word',
  });

const phoneSchema = z.object({
  country: z.string().length(2),
  dialCode: z.string().regex(/^\+\d{1,4}$/),
  national: z.string().regex(/^\d{4,15}$/),
  e164: z.string().regex(/^\+\d{5,19}$/),
});

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

/** Parse a body, turning a zod failure into the one envelope with the paths logged, not returned. */
async function body<Schema extends z.ZodType>(c: Context<AppEnv>, schema: Schema): Promise<z.infer<Schema>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', undefined, {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * A device label from the request, for the "sign out other devices" list.
 *
 * **Informational only, never a security boundary** (ADR-0005): it is client-supplied and spoofable, so
 * revocation is bounded by `familyId` instead. The client does not send one yet, so this is the
 * User-Agent — which is exactly the kind of label a human recognises in a device list.
 */
const deviceLabel = (c: Context<AppEnv>): string =>
  (c.req.header('x-device-id') ?? c.req.header('user-agent') ?? '').slice(0, 200);

/** The IP a request came from, for the alert on a successful password reset. */
const clientIp = (c: Context<AppEnv>): string =>
  (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? '').trim();

/**
 * Mint a fresh session: an access token and a **new refresh family**.
 *
 * One family per login, so a second device does not join the first device's rotation chain — otherwise a
 * theft on one would revoke the other, and "sign out other devices" could not be expressed.
 */
async function beginSession(
  config: Config,
  user: users.User,
  device: string,
  now: Date,
): Promise<{ accessToken: string; refreshToken: string }> {
  const issued = await refreshTokens.issueNewFamily(
    user._id,
    device,
    refreshTokenExpiry(config, now),
    now,
  );

  return {
    accessToken: await mintAccessToken(config, {
      userId: user._id.toHexString(),
      securityEpoch: user.securityEpoch,
    }),
    refreshToken: issued.token,
  };
}

export const authRoutes = new Hono<AppEnv>();

// ── Registration ──────────────────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  /** The date the user chose, not an age: an age computed on the client changes without the server. */
  dateOfBirth: z.string(),
  phone: phoneSchema.optional(),
  password: passwordSchema,
  displayCurrency: z.string().length(3),
  salary: moneyInputSchema,
  savingsGoal: moneyInputSchema,
  /**
   * Submit and "Skip for now" are the same request and the same figure — 20% of salary either way — and
   * this is the only field that can tell them apart.
   */
  goalWasSkipped: z.boolean(),
  securityAnswers: securityAnswersSchema,
  acceptedTerms: z.boolean(),
  timeZone: timezoneSchema,
  language: z.enum(['en', 'ar']),
  /**
   * The install this registration came from, so the events it recorded before there was an account can be
   * stitched to it — which is what makes activation measurable across the registration boundary.
   */
  installId: z.string().min(1).max(100).nullish(),
});

/**
 * `POST /v1/auth/register` — everything the three steps collected, in one request, answering with a
 * signed-in session.
 *
 * Nothing is persisted until this body arrives, so there is no partial user, no orphan reaper, and no
 * "exists but has no salary" state (ADR-0004). Email uniqueness is decided by the unique index rather
 * than by a prior lookup, so two racing signups cannot both succeed.
 */
authRoutes.post('/v1/auth/register', async (c) => {
  const input = await body(c, registerSchema);
  const now = new Date();

  if (!input.acceptedTerms) throw new ApiError('TERMS_NOT_ACCEPTED');

  const dob = calendarDate(input.dateOfBirth);
  if (dob === null) {
    throw new ApiError('VALIDATION_FAILED', undefined, { dateOfBirth: 'expected YYYY-MM-DD' });
  }
  // The 13+ gate, computed in the zone the device reported — a birthday is a local fact.
  if (ageInYears(dob, now, input.timeZone) < 13) throw new ApiError('UNDER_AGE');

  if (input.salary.currency !== input.savingsGoal.currency) {
    throw new ApiError('VALIDATION_FAILED', undefined, {
      savingsGoal: 'must be authored in the same currency as the salary',
    });
  }

  // Hashed over the **normalised** form. Hashing the raw string would make every tolerance the
  // normaliser offers unreachable, because a hash cannot be compared fuzzily (invariant 5).
  const [passwordHash, securityQuestions] = await Promise.all([
    hashSecret(c.var.config, input.password),
    Promise.all(
      input.securityAnswers.map(async ({ questionId, answer }) => ({
        questionId,
        answerHash: await hashSecret(c.var.config, normaliseAnswer(answer)),
      })),
    ),
  ]);

  const user = await users.insertUser({
    email: input.email,
    passwordHash,
    displayName: input.name,
    phone: input.phone ?? null,
    dob,
    salary: input.salary,
    savingsGoal: input.savingsGoal,
    goalWasSkipped: input.goalWasSkipped,
    displayCurrency: input.displayCurrency.toUpperCase(),
    language: input.language,
    timezone: input.timeZone,
    securityQuestions,
  });

  if (input.installId !== null && input.installId !== undefined) {
    // Best-effort: a metrics stitch must never fail a registration.
    await stitchInstall(input.installId, user._id).catch((err: unknown) => {
      c.var.log.warn({ err }, 'could not stitch install events to the new account');
      return 0;
    });
  }

  c.var.log.info({ userId: user._id.toHexString() }, 'account registered');
  return c.json(await beginSession(c.var.config, user, deviceLabel(c), now), 201);
});

// ── Sign in ───────────────────────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  timeZone: timezoneSchema,
});

/**
 * `POST /v1/auth/login`.
 *
 * **The unknown-email path does the same work as the wrong-password path.** It verifies the presented
 * password against a decoy hash and discards the result, so both answer `INVALID_CREDENTIALS` after the
 * same ~20 ms of argon2. Returning early for an unknown address would leak account existence through a
 * response that arrives sooner — measurable over a few hundred requests, and it would make the lockout
 * itself the enumeration oracle ADR-0004 declined to build as an endpoint.
 *
 * Lockout is **per-account** (ADR-0010): three failed attempts from three different IPs still lock the
 * account, which is a sentence an IP-keyed limiter structurally cannot express.
 */
authRoutes.post('/v1/auth/login', async (c) => {
  const input = await body(c, loginSchema);
  const now = new Date();

  const user = await users.findByEmail(input.email);
  if (user === null) {
    await equaliseTiming(c.var.config, input.password);
    throw new ApiError('INVALID_CREDENTIALS');
  }

  // Checked before the password, so a locked account cannot be used as a password oracle either.
  if (users.isLocked(user.lockedUntil, now)) throw new ApiError('ACCOUNT_LOCKED');

  if (!(await verifySecret(user.passwordHash, input.password))) {
    await users.recordFailedLogin(user._id, now);
    throw new ApiError('INVALID_CREDENTIALS');
  }

  // Correct password, deleted account: the client turns this into an offer to restore rather than a
  // failure (ADR-0015), which is why it is reported after the password check and not before — telling
  // somebody an account is pending deletion before they prove they own it would be an enumeration leak.
  if (user.deletedAt !== null) throw new ApiError('ACCOUNT_PENDING_DELETION');

  await users.clearFailedLogins(user._id);
  // Captured on every sign-in, because a user who moved should have their day boundaries move with them.
  if (user.timezone !== input.timeZone) await users.setTimezone(user._id, input.timeZone);

  c.var.log.info({ userId: user._id.toHexString() }, 'signed in');
  return c.json(await beginSession(c.var.config, user, deviceLabel(c), now));
});

// ── Refresh ───────────────────────────────────────────────────────────────────────────────────

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
  timeZone: timezoneSchema,
});

/**
 * `POST /v1/auth/refresh` — rotation.
 *
 * Answers with a **new refresh token as well as a new access token**, because that is what rotation
 * means. A response carrying only an access token is how a client ends up presenting the same refresh
 * token twice and having its family revoked underneath it.
 *
 * Unauthenticated: the refresh token *is* the credential, and routing this through the session
 * middleware would recurse into itself.
 */
authRoutes.post('/v1/auth/refresh', async (c) => {
  const input = await body(c, refreshSchema);
  const now = new Date();

  const outcome = await refreshTokens.rotate(
    input.refreshToken,
    deviceLabel(c),
    refreshTokenExpiry(c.var.config, now),
    now,
  );

  if (outcome.kind === 'reused') {
    // The alarm, not the error. A token that has already been rotated is either a client bug or a theft,
    // and the family is revoked by `rotate` before this line runs. Logged at `warn` because it is the
    // one auth event worth looking at.
    c.var.log.warn(
      { userId: outcome.userId.toHexString(), familyId: outcome.familyId },
      'revoked refresh token presented — family revoked',
    );
    throw new ApiError('UNAUTHENTICATED');
  }
  if (outcome.kind !== 'rotated') throw new ApiError('UNAUTHENTICATED');

  const user = await users.findById(outcome.userId);
  if (user === null) throw new ApiError('UNAUTHENTICATED');
  if (user.deletedAt !== null) throw new ApiError('ACCOUNT_PENDING_DELETION');

  if (user.timezone !== input.timeZone) await users.setTimezone(user._id, input.timeZone);

  return c.json({
    accessToken: await mintAccessToken(c.var.config, {
      userId: user._id.toHexString(),
      securityEpoch: user.securityEpoch,
    }),
    refreshToken: outcome.issued.token,
  });
});

// ── Sign out ──────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/auth/logout` — revoke the family the client holds.
 *
 * **Authenticated**, which is why the client's `Authorization` rule is two cases rather than a
 * `/v1/auth/` prefix rule: this is the exception that would break one.
 *
 * The refresh token is named in the body rather than inferred, so the server revokes the family the
 * client actually has. A token it does not recognise is silently accepted: the caller asked to end a
 * session, and a session that is already gone is the outcome they wanted — reporting "no such token"
 * would give a probe a way to test tokens.
 */
authRoutes.post('/v1/auth/logout', requireSession(), async (c) => {
  const input = await body(c, z.object({ refreshToken: z.string().min(1).max(512) }));
  await refreshTokens.revokeFamilyOf(input.refreshToken, new Date());
  return c.json({});
});

/**
 * `POST /v1/auth/logout-all` — every session, everywhere.
 *
 * Revokes every family **and bumps `securityEpoch`**, which is the half that makes it immediate: without
 * the bump, the other device's access token would keep working until it expired, and the user would have
 * asked for something that appeared not to happen.
 */
authRoutes.post('/v1/auth/logout-all', requireSession(), async (c) => {
  const user = c.var.user;
  const revoked = await refreshTokens.revokeAllForUser(user._id, new Date());
  await users.bumpSecurityEpoch(user._id);

  c.var.log.info({ userId: user._id.toHexString(), revoked }, 'all sessions revoked');
  return c.json({});
});

// ── Recovery by security question ─────────────────────────────────────────────────────────────

/**
 * `POST /v1/auth/forgot-password/questions` — which two questions this account was set up with.
 *
 * **An unknown email gets two plausible question ids too**, derived deterministically from the address
 * so that asking twice gives the same answer. Returning an error, or an empty list, would make this an
 * account-enumeration oracle — and a *better* one than the login route, because it needs no password
 * guess and no lockout budget.
 *
 * A deterministic derivation rather than a random pair, because random ids would differ between two
 * requests for the same unknown address, which is itself the tell.
 */
authRoutes.post('/v1/auth/forgot-password/questions', async (c) => {
  const input = await body(c, z.object({ email: emailSchema }));
  const bank = getContent().securityQuestions.value.questions;

  const user = await users.findByEmail(input.email);

  const ids =
    user === null
      ? decoyQuestionIds(users.canonicalEmail(input.email), bank.length)
      : user.securityQuestions.map(({ questionId }) => questionId);

  return c.json({
    questions: ids.map((id) => bank.find((question) => question.id === id) ?? bank[0]),
  });
});

/**
 * Two stable, plausible question ids for an address that has no account.
 *
 * A cheap deterministic hash of the address rather than a cryptographic one: nothing secret is being
 * protected, the only requirement is that the same input give the same pair every time. The second id is
 * forced to differ from the first, because two identical questions would be the tell this exists to
 * avoid.
 */
function decoyQuestionIds(email: string, bankSize: number): string[] {
  let hash = 0;
  for (const character of email) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100_000;

  const first = hash % bankSize;
  const second = (first + 1 + (Math.trunc(hash / bankSize) % (bankSize - 1))) % bankSize;
  return [first, second].map((index) => `sq${String(index + 1).padStart(2, '0')}`);
}

const verifySchema = z.object({
  email: emailSchema,
  /**
   * Date of birth as a third factor.
   *
   * Two low-entropy answers are the whole of takeover defence on an app holding salary and spending
   * data, and the unverified email is not even a channel for warning the real owner. DOB is already
   * collected for the 13+ gate, costs the user one field, and meaningfully raises the bar
   * (BACKEND_PLAN §4.2.1).
   */
  dateOfBirth: z.string(),
  answers: securityAnswersSchema,
});

/**
 * `POST /v1/auth/forgot-password/verify` — email, both answers and DOB in; a single-use ticket out.
 *
 * **It never reveals which answer failed.** The design reddens the specific field, which it can only do
 * because it compares raw strings in the browser (defect D4). Telling somebody which of two guesses
 * landed halves the work of guessing the other.
 *
 * Recovery has its own lockout counters, separate from login's, because it is now the *only* way back
 * into an account — sharing login's would let a stranger's failed password guesses lock you out of your
 * own recovery.
 */
authRoutes.post('/v1/auth/forgot-password/verify', async (c) => {
  const input = await body(c, verifySchema);
  const now = new Date();

  const user = await users.findByEmail(input.email);
  if (user === null) {
    // Same work, same code: two argon2 verifies, matching what the real path pays.
    await Promise.all(input.answers.map(async ({ answer }) => equaliseTiming(c.var.config, normaliseAnswer(answer))));
    throw new ApiError('SECURITY_ANSWERS_INVALID');
  }

  if (users.isLocked(user.recoveryLockedUntil, now)) throw new ApiError('ACCOUNT_LOCKED');

  const dobMatches =
    calendarDate(input.dateOfBirth)?.getTime() === user.dob.getTime();

  // Both answers verified **whatever the DOB said**, so the response time does not reveal which factor
  // failed first. The results are combined at the end.
  const answersMatch = await Promise.all(
    user.securityQuestions.map(async ({ questionId, answerHash }) => {
      const given = input.answers.find((answer) => answer.questionId === questionId);
      if (given === undefined) {
        await equaliseTiming(c.var.config, '');
        return false;
      }
      return verifySecret(answerHash, normaliseAnswer(given.answer));
    }),
  );

  if (!dobMatches || answersMatch.includes(false)) {
    await users.recordFailedRecovery(user._id, now);
    throw new ApiError('SECURITY_ANSWERS_INVALID');
  }

  await users.clearFailedRecoveries(user._id);
  const ticket = await passwordResets.issueTicket(user._id, clientIp(c), now);

  c.var.log.info({ userId: user._id.toHexString() }, 'recovery verified, reset ticket issued');
  return c.json({ ticket, expiresInSeconds: passwordResets.TICKET_TTL_MS / 1_000 });
});

/**
 * `POST /v1/auth/reset-password` — spend the ticket, set the password.
 *
 * Revokes **every** family and bumps `securityEpoch`, so a takeover that got this far does not leave the
 * real owner's other devices signed in — and, symmetrically, a real owner recovering their account signs
 * out whoever else was in it.
 *
 * Every successful reset is logged at `warn`. This is the only route back into an account and it is
 * defended by two low-entropy answers, so it is the event an operator should be able to find.
 */
authRoutes.post('/v1/auth/reset-password', async (c) => {
  const input = await body(
    c,
    z.object({ ticket: z.string().min(1).max(512), newPassword: passwordSchema }),
  );
  const now = new Date();

  const userId = await passwordResets.spendTicket(input.ticket, now);
  await users.setPassword(userId, await hashSecret(c.var.config, input.newPassword), now);
  await refreshTokens.revokeAllForUser(userId, now);

  c.var.log.warn(
    { userId: userId.toHexString(), ip: clientIp(c) },
    'password reset via security questions — all sessions revoked',
  );
  return c.json({});
});
