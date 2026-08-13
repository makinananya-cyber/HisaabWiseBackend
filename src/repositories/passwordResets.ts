import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { hashOpaqueToken, mintOpaqueToken } from '../auth/hashing';
import { ApiError } from '../errors';
import { collection, COLLECTIONS } from './collections';

/**
 * The `password_resets` collection — **single-use reset tickets**, not emailed tokens.
 *
 * The Technical Spec designed this collection around a link in an email. Recovery is by security
 * question instead (BACKEND_PLAN §4.2.1), so the collection survives with a different job: it holds the
 * short-lived ticket issued *after* email, both security answers and date of birth have verified, and
 * spent by `POST /v1/auth/reset-password`.
 *
 * **Why a ticket at all**, rather than resetting the password in the same call that verifies the
 * answers: the client walks two screens, and a single call would mean holding the new password in the
 * same request as the answers before the user has typed it. The ticket is what lets step 2 succeed and
 * step 3 happen separately, without the server keeping session-scoped "this browser got past step 2"
 * state — which is the thing the in-session password change was deliberately designed to avoid.
 *
 * Short-lived, on purpose: minutes, not hours. A ticket is a bearer credential that skips the password,
 * so its window is the window in which a stolen one is worth having.
 */

/** Ten minutes. Long enough to type a password, short enough that a leaked ticket is usually stale. */
export const TICKET_TTL_MS = 10 * 60 * 1_000;

const resetSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  ticketHash: z.string().length(64),
  expiresAt: z.date(),
  usedAt: z.date().nullable(),
  createdAt: z.date(),
  /** For the alert on every successful reset — this is the only route back into an account. */
  createdIp: z.string(),
});

export type PasswordReset = z.infer<typeof resetSchema>;

const resets = () => collection<OptionalId<PasswordReset>>(COLLECTIONS.passwordResets);

function parse(document: unknown): PasswordReset {
  const result = resetSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', undefined, {
      collection: COLLECTIONS.passwordResets,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * Issue a ticket, invalidating any the user already had.
 *
 * The invalidation matters: without it, a user who ran the recovery flow twice would be holding two
 * live tickets, and the older one would outlive the attempt that produced it.
 */
export async function issueTicket(userId: ObjectId, ip: string, now: Date): Promise<string> {
  await resets().updateMany({ userId, usedAt: null }, { $set: { usedAt: now } });

  const ticket = mintOpaqueToken();
  await resets().insertOne({
    userId,
    ticketHash: hashOpaqueToken(ticket),
    expiresAt: new Date(now.getTime() + TICKET_TTL_MS),
    usedAt: null,
    createdAt: now,
    createdIp: ip,
  });

  return ticket;
}

/**
 * Spend a ticket, returning the user it belongs to.
 *
 * The claim is a **conditional update** — `usedAt: null` and an unexpired `expiresAt` in the filter —
 * so "single use" is enforced by the write rather than by a read the caller might race. Two requests
 * presenting the same ticket cannot both reset the password.
 *
 * @throws {ApiError} `RESET_TICKET_INVALID` for unknown, expired, and already-spent alike. One code,
 * because the distinctions are only useful to somebody testing tickets.
 */
export async function spendTicket(ticket: string, now: Date): Promise<ObjectId> {
  const claimed = await resets().findOneAndUpdate(
    { ticketHash: hashOpaqueToken(ticket), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' },
  );

  if (claimed === null) throw new ApiError('RESET_TICKET_INVALID');
  return parse(claimed).userId;
}

/** Erase every ticket for a user. For the hard purge. */
export async function deleteAllForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await resets().deleteMany({ userId });
  return deletedCount;
}
