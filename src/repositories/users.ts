import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { ApiError } from '../errors';
import { storedMoneySchema, type Money } from '../types/money';
import { collection, COLLECTIONS, isDuplicateKeyError } from './collections';

/**
 * The `users` collection — the identity record, and **the single owner of salary** (invariant 2).
 *
 * No screen may hardcode a salary and no other collection may hold one. That is defect D1, and it is
 * why every screen payload reads the figure from here rather than carrying its own copy.
 *
 * **Every document is zod-parsed on the way out, not only on the way in** (ADR-0002). A bare-number
 * `salary` written by a seed script or by a deploy predating the `Money` type would otherwise flow
 * straight into the budget engine and onto a screen; here it throws at the boundary, naming the field.
 */

// ── The document ──────────────────────────────────────────────────────────────────────────────

/**
 * A phone number, stored with the parts it was built from.
 *
 * **A departure from DATA_MODEL §3.1's `phone: string?`**, and the reason is the Account screen: it
 * redraws the field as a dial-code picker plus national digits, so storing only `+971501234567` would
 * mean parsing a country back out of a prefix — ambiguous, because `+1` is shared by twenty-odd
 * countries. The parts are what the client sent and what it needs back.
 *
 * Collected and **never verified** (O2): no OTP, no SMS provider, and nothing in the system may treat a
 * phone number as proof of anything.
 */
const phoneSchema = z.object({
  country: z.string().length(2),
  dialCode: z.string().regex(/^\+\d+$/),
  national: z.string().regex(/^\d+$/),
  e164: z.string().regex(/^\+\d+$/),
});

export type Phone = z.infer<typeof phoneSchema>;

const securityQuestionSchema = z.object({
  /** The opaque `sq01`…`sq14` id. Never the English text, which is localisable display content. */
  questionId: z.string().regex(/^sq\d{2}$/),
  /** argon2id over the **normalised** answer. Hashing the raw string would break every tolerance. */
  answerHash: z.string().min(1),
});

/**
 * The stored user, as read back.
 *
 * `passwordHash` and `answerHash` are in here because repositories are the only code that sees them;
 * nothing above this layer receives a hash, and no route returns one.
 */
const userSchema = z.object({
  _id: z.instanceof(ObjectId),
  email: z.string().min(3),
  emailVerifiedAt: z.date(),
  passwordHash: z.string().min(1),
  passwordChangedAt: z.date(),
  displayName: z.string().min(1),
  phone: phoneSchema.nullable(),
  dob: z.date(),
  salary: storedMoneySchema,
  savingsGoal: storedMoneySchema,
  goalWasSkipped: z.boolean(),
  displayCurrency: z.string().length(3),
  language: z.enum(['en', 'ar']),
  timezone: z.string().min(1),
  securityQuestions: z.array(securityQuestionSchema).length(2),
  securityEpoch: z.number().int().positive(),
  failedLoginCount: z.number().int().min(0),
  lockedUntil: z.date().nullable(),
  recoveryFailedCount: z.number().int().min(0),
  recoveryLockedUntil: z.date().nullable(),
  pushTokens: z.array(z.object({ deviceId: z.string(), token: z.string() })),
  streakOptIn: z.boolean(),
  deletedAt: z.date().nullable(),
  createdAt: z.date(),
});

export type User = z.infer<typeof userSchema>;

/** What a new account is created from. Everything else has a server-owned default. */
export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly phone: Phone | null;
  readonly dob: Date;
  readonly salary: Money;
  readonly savingsGoal: Money;
  readonly goalWasSkipped: boolean;
  readonly displayCurrency: string;
  readonly language: 'en' | 'ar';
  readonly timezone: string;
  readonly securityQuestions: { questionId: string; answerHash: string }[];
}

const users = () => collection<OptionalId<User>>(COLLECTIONS.users);

/**
 * Parse a document read from the collection.
 *
 * @throws {ApiError} `INTERNAL` — a stored document that does not match the schema is a data-integrity
 * problem, not a client error, and the client can do nothing about it. The failing paths go to the log,
 * never to the response: they would name internal field structure.
 */
function parse(document: unknown): User {
  const result = userSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', undefined, {
      collection: COLLECTIONS.users,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

const parseOptional = (document: unknown): User | null =>
  document === null ? null : parse(document);

// ── Identity ──────────────────────────────────────────────────────────────────────────────────

/**
 * The canonical form of an email address for storage and lookup.
 *
 * Lowercased and trimmed, and **that is all** — no dot-stripping, no plus-tag removal. Those are
 * provider-specific behaviours, and applying Gmail's rules to every domain would silently merge two
 * genuinely different addresses into one account.
 */
export const canonicalEmail = (email: string): string => email.trim().toLowerCase();

export const findByEmail = async (email: string): Promise<User | null> =>
  parseOptional(await users().findOne({ email: canonicalEmail(email) }));

export const findById = async (id: string | ObjectId): Promise<User | null> =>
  parseOptional(await users().findOne({ _id: new ObjectId(id) }));

/**
 * Insert a new account.
 *
 * @throws {ApiError} `EMAIL_TAKEN` when the unique index refuses it. **The index decides, not a prior
 * lookup**: two registrations racing on the same address would both pass a check-then-insert. This is
 * also the only way a caller ever learns an address is taken — there is deliberately no
 * email-availability endpoint, because one answers "does this person bank here" to anybody who asks
 * (ADR-0004).
 *
 * A soft-deleted account still holds its email: the address stays reserved through the 30-day grace
 * period and is released by `purge:deleted`. So this correctly refuses, and sign-in is where the
 * restore offer lives.
 */
export async function insertUser(user: NewUser): Promise<User> {
  const now = new Date();
  const document = {
    ...user,
    email: canonicalEmail(user.email),
    // Nothing is verified out of band, and the field stays in the contract as always-true so the
    // client's ~50 references and two fixtures remain valid shapes (BACKEND_PLAN §4.2.2).
    emailVerifiedAt: now,
    passwordChangedAt: now,
    // Starts at 1, not 0, so a token minted with `sec: 0` from some future bug cannot pass as current.
    securityEpoch: 1,
    failedLoginCount: 0,
    lockedUntil: null,
    recoveryFailedCount: 0,
    recoveryLockedUntil: null,
    pushTokens: [],
    streakOptIn: false,
    deletedAt: null,
    createdAt: now,
  };

  try {
    const { insertedId } = await users().insertOne(document);
    return parse({ ...document, _id: insertedId });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ApiError('EMAIL_TAKEN');
    throw err;
  }
}

// ── Lockout (ADR-0010) ────────────────────────────────────────────────────────────────────────

/**
 * How many failures lock an account, and for how long.
 *
 * **Per-account, which is the whole point.** An IP-keyed limiter structurally cannot express "three
 * failed attempts on this account" — three attempts from three addresses look like three unrelated
 * requests to it. Volumetric IP throttling sits *beneath* this as a separate concern.
 */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1_000;

/** Whether a lock is currently in force. A lock in the past is expired, not a lock. */
export const isLocked = (until: Date | null, now: Date): boolean =>
  until !== null && until.getTime() > now.getTime();

/**
 * Record a failed sign-in, locking the account when it crosses the threshold.
 *
 * One atomic `findOneAndUpdate` rather than read-modify-write, so concurrent attempts each count. A
 * write per *failed* login only — successful logins do not write, so the cost is negligible.
 */
export async function recordFailedLogin(id: ObjectId, now: Date): Promise<void> {
  const after = await users().findOneAndUpdate(
    { _id: id },
    { $inc: { failedLoginCount: 1 } },
    { returnDocument: 'after', projection: { failedLoginCount: 1 } },
  );

  const count = (after as { failedLoginCount?: number } | null)?.failedLoginCount ?? 0;
  if (count >= MAX_FAILED_LOGINS) {
    await users().updateOne(
      { _id: id },
      { $set: { lockedUntil: new Date(now.getTime() + LOCKOUT_MS), failedLoginCount: 0 } },
    );
  }
}

/** Clear the counters after a successful sign-in. */
export const clearFailedLogins = async (id: ObjectId): Promise<void> => {
  await users().updateOne({ _id: id }, { $set: { failedLoginCount: 0, lockedUntil: null } });
};

/**
 * Record a failed recovery attempt.
 *
 * **Separate counters from login's**, and not for tidiness: recovery is now the *only* way back into an
 * account, so it needs its own budget. Sharing login's would mean a stranger's failed guesses at your
 * password locking you out of the mechanism you would use to recover.
 */
export async function recordFailedRecovery(id: ObjectId, now: Date): Promise<void> {
  const after = await users().findOneAndUpdate(
    { _id: id },
    { $inc: { recoveryFailedCount: 1 } },
    { returnDocument: 'after', projection: { recoveryFailedCount: 1 } },
  );

  const count = (after as { recoveryFailedCount?: number } | null)?.recoveryFailedCount ?? 0;
  if (count >= MAX_FAILED_LOGINS) {
    await users().updateOne(
      { _id: id },
      { $set: { recoveryLockedUntil: new Date(now.getTime() + LOCKOUT_MS), recoveryFailedCount: 0 } },
    );
  }
}

export const clearFailedRecoveries = async (id: ObjectId): Promise<void> => {
  await users().updateOne(
    { _id: id },
    { $set: { recoveryFailedCount: 0, recoveryLockedUntil: null } },
  );
};

// ── Mutations ─────────────────────────────────────────────────────────────────────────────────

/**
 * Replace the password, bumping `securityEpoch` so outstanding access tokens die at once.
 *
 * The epoch bump is the difference between "the other device stops working now" and "the other device
 * stops working within fifteen minutes", and Product Spec §3.7 asks for the former.
 */
export async function setPassword(id: ObjectId, passwordHash: string, now: Date): Promise<void> {
  await users().updateOne(
    { _id: id },
    { $set: { passwordHash, passwordChangedAt: now }, $inc: { securityEpoch: 1 } },
  );
}

/** Bump the epoch on its own — what `logout-all` does. */
export const bumpSecurityEpoch = async (id: ObjectId): Promise<void> => {
  await users().updateOne({ _id: id }, { $inc: { securityEpoch: 1 } });
};

/**
 * Store the timezone the device reported.
 *
 * Captured at registration, login and refresh (ADR-0023), because invariant 6 computes every day
 * boundary in the *stored* zone: rollover, day keys and streaks all read it, and none of them may read
 * the device clock. A user who flies to London and opens the app has their zone updated on the next
 * refresh — which is correct, and is why the streak is evaluated lazily against `lastActiveDayKey`
 * rather than recomputed from a moving zone.
 */
export const setTimezone = async (id: ObjectId, timezone: string): Promise<void> => {
  await users().updateOne({ _id: id }, { $set: { timezone } });
};

export const setLanguage = async (id: ObjectId, language: 'en' | 'ar'): Promise<void> => {
  await users().updateOne({ _id: id }, { $set: { language } });
};

export const setDisplayCurrency = async (id: ObjectId, displayCurrency: string): Promise<void> => {
  await users().updateOne({ _id: id }, { $set: { displayCurrency: displayCurrency.toUpperCase() } });
};

/**
 * The three editable personal details, replaced together.
 *
 * **Email is not among them**, and cannot be: it is the identity (invariant 4), it is locked on the
 * screen, and there is no parameter here for a client bug or a future refactor to fill in.
 */
export async function setPersonalDetails(
  id: ObjectId,
  details: { displayName: string; salary: Money; phone: Phone | null },
): Promise<void> {
  await users().updateOne({ _id: id }, { $set: details });
}

export const setSavingsGoal = async (
  id: ObjectId,
  savingsGoal: Money,
  goalWasSkipped: boolean,
): Promise<void> => {
  await users().updateOne({ _id: id }, { $set: { savingsGoal, goalWasSkipped } });
};
