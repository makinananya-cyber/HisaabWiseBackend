import { randomUUID } from 'node:crypto';

import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { hashOpaqueToken, mintOpaqueToken } from '../auth/hashing';
import { ApiError } from '../errors';
import { collection, COLLECTIONS } from './collections';

/**
 * The `refresh_tokens` collection — rotation, and the family revocation that makes it safe (ADR-0005).
 *
 * **The rule that matters: presenting an already-revoked token revokes the whole family.** Rotation
 * alone is not a defence. If an attacker steals a refresh token and the real user rotates it, rotation
 * gives the attacker a dead token and no signal that anything happened. Family revocation turns that
 * dead token into an alarm — the next use of *any* token in the chain kills the login it descended
 * from, so the legitimate user is signed out and has to sign in again. That is the intended outcome: a
 * signed-out user is recoverable, a silently shared session is not.
 *
 * **`familyId` and not `deviceId`.** A device id is client-supplied and spoofable, so it cannot bound a
 * revocation. `familyId` is minted server-side at login and inherited by every token in the rotation
 * chain, which is exactly the set that has to die together. `deviceId` survives as a display label for
 * "sign out other devices" and nothing else.
 *
 * Tokens are stored as **SHA-256, not argon2** (ADR-0004): 32 bytes of CSPRNG have no low-entropy
 * secret for a slow hash to protect, and argon2 here would burn CPU on every app foreground.
 */

const refreshTokenSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  tokenHash: z.string().length(64),
  familyId: z.uuid(),
  replacedBy: z.instanceof(ObjectId).nullable(),
  /** Client-supplied, informational only. Never a security boundary. */
  deviceId: z.string(),
  expiresAt: z.date(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});

export type StoredRefreshToken = z.infer<typeof refreshTokenSchema>;

const tokens = () => collection<OptionalId<StoredRefreshToken>>(COLLECTIONS.refreshTokens);

function parse(document: unknown): StoredRefreshToken {
  const result = refreshTokenSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', undefined, {
      collection: COLLECTIONS.refreshTokens,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/** A newly issued token: the value to hand to the client, and the row that records it. */
export interface IssuedToken {
  /** The only time this value exists in plaintext. Never logged, never stored, never returned twice. */
  readonly token: string;
  readonly id: ObjectId;
  readonly familyId: string;
}

/**
 * Issue a token, starting a new family.
 *
 * One family per login, so signing in on a second device does not put it in the first device's chain —
 * otherwise a theft on one device would revoke the other, and "sign out other devices" could not be
 * expressed at all.
 */
export async function issueNewFamily(
  userId: ObjectId,
  deviceId: string,
  expiresAt: Date,
  now: Date,
): Promise<IssuedToken> {
  return issue(userId, randomUUID(), deviceId, expiresAt, now);
}

async function issue(
  userId: ObjectId,
  familyId: string,
  deviceId: string,
  expiresAt: Date,
  now: Date,
): Promise<IssuedToken> {
  const token = mintOpaqueToken();
  const { insertedId } = await tokens().insertOne({
    userId,
    tokenHash: hashOpaqueToken(token),
    familyId,
    replacedBy: null,
    deviceId,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  });

  return { token, id: insertedId, familyId };
}

/** What a rotation attempt found. The three outcomes are genuinely different and are handled differently. */
export type RotationOutcome =
  /** No row for this token. A forgery, or a token from a purged account. */
  | { readonly kind: 'unknown' }
  /**
   * The token exists and has already been used or revoked. **The family is revoked as a side effect
   * of reporting this** — the caller does not have to remember to, because a caller who forgot would
   * turn the alarm into a no-op.
   */
  | { readonly kind: 'reused'; readonly userId: ObjectId; readonly familyId: string }
  /** Expired on its own, without being used. Not an attack; just a device that was away too long. */
  | { readonly kind: 'expired' }
  | { readonly kind: 'rotated'; readonly userId: ObjectId; readonly issued: IssuedToken };

/**
 * Rotate a presented refresh token: revoke it, issue its successor, and record the link.
 *
 * The revoke is a **conditional update** (`revokedAt: null` in the filter) rather than a read followed
 * by a write, so two concurrent refreshes with the same token cannot both succeed. The loser sees the
 * row already revoked and reports `reused`, which revokes the family — which is the correct, if harsh,
 * answer: the client's single-flight refresh (iOS ADR-0007) exists precisely so this does not happen
 * from ordinary concurrency, and if it does happen the two possibilities are a client bug or a theft.
 */
export async function rotate(
  presented: string,
  deviceId: string,
  expiresAt: Date,
  now: Date,
): Promise<RotationOutcome> {
  const tokenHash = hashOpaqueToken(presented);
  const existing = await tokens().findOne({ tokenHash });
  if (existing === null) return { kind: 'unknown' };

  const row = parse(existing);

  if (row.revokedAt !== null) {
    await revokeFamily(row.familyId, now);
    return { kind: 'reused', userId: row.userId, familyId: row.familyId };
  }

  if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

  const claimed = await tokens().findOneAndUpdate(
    { _id: row._id, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  // Lost the race: another refresh revoked it between the read and the update. Reported as reuse for
  // the same reason a genuinely replayed token is — from here the two are indistinguishable, and the
  // safe reading of an indistinguishable case is the alarming one.
  if (claimed === null) {
    await revokeFamily(row.familyId, now);
    return { kind: 'reused', userId: row.userId, familyId: row.familyId };
  }

  const issued = await issue(row.userId, row.familyId, deviceId, expiresAt, now);
  await tokens().updateOne({ _id: row._id }, { $set: { replacedBy: issued.id } });

  return { kind: 'rotated', userId: row.userId, issued };
}

/** Revoke every token descended from one login. */
export async function revokeFamily(familyId: string, now: Date): Promise<number> {
  const { modifiedCount } = await tokens().updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return modifiedCount;
}

/**
 * Revoke the family a presented token belongs to. What `POST /v1/auth/logout` does.
 *
 * Idempotent and silent about a token it does not recognise: the caller asked to end a session, and a
 * session that is already gone is the outcome they wanted. Returning "no such token" would give a
 * probe a way to test tokens.
 */
export async function revokeFamilyOf(presented: string, now: Date): Promise<void> {
  const existing = await tokens().findOne({ tokenHash: hashOpaqueToken(presented) });
  if (existing === null) return;
  await revokeFamily(parse(existing).familyId, now);
}

/** Revoke every family for a user. What `logout-all`, a password change, and deletion do. */
export async function revokeAllForUser(userId: ObjectId, now: Date): Promise<number> {
  const { modifiedCount } = await tokens().updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return modifiedCount;
}

/**
 * Revoke every family for a user **except** the one presented.
 *
 * The password-change case: Product Spec §3.7 revokes every *other* session, and signing the user out
 * of the device they just used to change their password would be a confusing way to confirm success.
 */
export async function revokeOtherFamilies(
  userId: ObjectId,
  keepFamilyId: string,
  now: Date,
): Promise<number> {
  const { modifiedCount } = await tokens().updateMany(
    { userId, familyId: { $ne: keepFamilyId }, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return modifiedCount;
}

/** The family a presented token belongs to, or null. For the password-change keep-this-one case. */
export async function familyOf(presented: string): Promise<string | null> {
  const existing = await tokens().findOne({ tokenHash: hashOpaqueToken(presented) });
  return existing === null ? null : parse(existing).familyId;
}

/** Erase every token for a user. For the hard purge, where revoking is not enough. */
export async function deleteAllForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await tokens().deleteMany({ userId });
  return deletedCount;
}
