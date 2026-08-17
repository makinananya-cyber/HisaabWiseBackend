import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import type { Progress } from '../domain/learn';
import { ApiError } from '../errors';
import { collection, COLLECTIONS } from './collections';

/**
 * The `learn_progress` collection — one document per user, **server-owned so it survives a reinstall**.
 *
 * Two storage decisions worth knowing:
 *
 *  - **`done` stores counts, not accuracy.** A rounded accuracy cannot be recomputed, and a stored 75%
 *    can never be reconciled against 3 of 4. Accuracy is derived on read.
 *  - **`streak` is a checkpoint, not the answer.** The *returned* streak is evaluated lazily against
 *    `lastActiveDayKey` in the stored timezone, so no nightly job is needed and a device-clock change
 *    cannot move it (Product Spec §4.4).
 *
 * Unit unlocking and each lesson's state are **not stored** — they are derived from `done` against the
 * bundled curriculum, so a curriculum change cannot leave stale state behind.
 */

/**
 * The stored shape, with **every map defaulted**.
 *
 * The defaults are not decoration. A completion upserts with `$set` on `done.<lessonId>` and `$unset` on
 * `progress.<lessonId>`, so the document MongoDB creates has a `done` map and **no `progress` field at
 * all** — unsetting a subfield of something that does not exist creates nothing. Requiring `progress` here
 * made the very next read of a first-ever completion fail the boundary and answer `500`.
 *
 * Defaulting rather than adding `$setOnInsert: { progress: {} }` is the better fix: that would conflict
 * with the `$unset` on the same path, and it would leave the schema still assuming a shape the writes do
 * not guarantee. A read boundary should tolerate a document written by any version of the writer.
 */
const progressSchema = z.object({
  userId: z.instanceof(ObjectId),
  xp: z.number().int().min(0).default(0),
  streak: z.number().int().min(0).default(0),
  lastActiveDayKey: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  done: z
    .record(
      z.string(),
      z.object({
        correct: z.number().int().min(0),
        total: z.number().int().min(0),
        xp: z.number().int().min(0),
      }),
    )
    .default({}),
  progress: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Every day key a lesson was finished on, newest last. Bounded — it draws one week. */
  activeDayKeys: z.array(z.string()).default([]),
  updatedAt: z.date().default(() => new Date(0)),
});

export type StoredProgress = z.infer<typeof progressSchema>;

const progressCollection = () => collection<OptionalId<StoredProgress>>(COLLECTIONS.learnProgress);

function parse(document: unknown): StoredProgress {
  const result = progressSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', 'a learn-progress document does not match its schema', {
      collection: COLLECTIONS.learnProgress,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/** How many day keys are kept. Fourteen covers the week strip with room for a timezone shift either side. */
const ACTIVE_DAYS_KEPT = 14;

/**
 * A user's progress, or an empty record.
 *
 * Empty rather than null for the same reason `fixedCosts.forUser` is: "no document yet" and "nothing done
 * yet" are the same screen, and pushing that into every caller means one of them eventually gets it wrong.
 */
export async function forUser(userId: ObjectId): Promise<StoredProgress> {
  const document = await progressCollection().findOne({ userId });
  if (document === null) {
    return {
      userId,
      xp: 0,
      streak: 0,
      lastActiveDayKey: null,
      done: {},
      progress: {},
      activeDayKeys: [],
      updatedAt: new Date(0),
    };
  }
  return parse(document);
}

/** The domain's view of a stored record. */
export const asProgress = (stored: StoredProgress): Progress => ({
  xp: stored.xp,
  streak: stored.streak,
  lastActiveDayKey: stored.lastActiveDayKey,
  done: stored.done,
  progress: stored.progress,
});

/**
 * Record a completed lesson.
 *
 * **XP is granted on first completion only** (defect D13): `xpAwarded` is what the caller decided, and it
 * is zero on a replay. The `done` entry is written either way, because a better second run should update
 * the counts the ring is drawn from — a reader who scored 3 of 4 and then 4 of 4 has earned the full ring.
 *
 * The partial position is cleared: the lesson is finished, so there is nothing to resume.
 */
export async function recordCompletion(
  userId: ObjectId,
  lessonId: string,
  result: { correct: number; total: number; xpAwarded: number },
  streak: { value: number; dayKey: string },
  now: Date,
): Promise<void> {
  const existing = await forUser(userId);
  const activeDayKeys = existing.activeDayKeys.includes(streak.dayKey)
    ? existing.activeDayKeys
    : [...existing.activeDayKeys, streak.dayKey].slice(-ACTIVE_DAYS_KEPT);

  await progressCollection().updateOne(
    { userId },
    {
      $set: {
        [`done.${lessonId}`]: {
          correct: result.correct,
          total: result.total,
          // The XP this lesson has ever earned, so a replay does not overwrite the first award with zero.
          xp: Math.max(existing.done[lessonId]?.xp ?? 0, result.xpAwarded),
        },
        streak: streak.value,
        lastActiveDayKey: streak.dayKey,
        activeDayKeys,
        updatedAt: now,
      },
      $inc: { xp: result.xpAwarded },
      $unset: { [`progress.${lessonId}`]: '' },
    },
    { upsert: true },
  );
}

/**
 * Record how far into a lesson the reader got.
 *
 * Deliberately does **not** touch XP or the streak: a partial run has earned neither, and a failure here
 * costs the reader the tail of one run rather than anything they had.
 */
export async function recordPosition(
  userId: ObjectId,
  lessonId: string,
  stepIndex: number,
  now: Date,
): Promise<void> {
  await progressCollection().updateOne(
    { userId },
    {
      $set: { [`progress.${lessonId}`]: stepIndex, updatedAt: now },
      $setOnInsert: { xp: 0, streak: 0, lastActiveDayKey: null, done: {}, activeDayKeys: [] },
    },
    { upsert: true },
  );
}

/** Erase a user's progress. For the hard purge. */
export async function deleteForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await progressCollection().deleteOne({ userId });
  return deletedCount;
}
