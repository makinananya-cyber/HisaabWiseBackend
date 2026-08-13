import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { ApiError } from '../errors';
import { storedMoneySchema } from '../types/money';
import { collection, COLLECTIONS, isDuplicateKeyError } from './collections';
import { LOG_CATEGORIES } from './expenseEntries';

/**
 * The `month_archives` collection — **immutable**, and the most carefully designed document in the system.
 *
 * The month-rollover job writes it and Reports reads it forever, so two properties are load-bearing:
 *
 *  1. **The unique `(userId, monthKey)` index is the idempotency backbone of the rollover job.** A retry
 *     cannot double-write, and that is enforced by the index rather than by the job remembering to check.
 *     It is the reason rollover is safe to run every fifteen minutes and safe to run twice.
 *  2. **`saved`, `net`, `verdict` and `adapted` are sealed, not recomputed.** They are the month's *story*.
 *     Changing display currency later must convert the figures without ever changing whether the goal was
 *     met; recomputing them against a different rate set could flip a `hit` to a `near`, which is exactly
 *     defect D6. Everything else on a report — per-category totals, the split bar's segments, the facts
 *     grid, every label — is derived from the stored entries at read time.
 *
 * `fxRateSetId` is **pinned** for the same reason (invariant 7): all conversion of this month goes through
 * that set forever.
 */

const archivedEntrySchema = z.object({
  id: z.string().min(1),
  category: z.enum(LOG_CATEGORIES),
  amount: storedMoneySchema,
  label: z.string(),
  /** A **full** timestamp. The prototype stored a day-of-month, which cannot order two entries in a day. */
  entryDate: z.date(),
});

const monthArchiveSchema = z.object({
  _id: z.instanceof(ObjectId),
  userId: z.instanceof(ObjectId),
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  /** Salary and goal **as they stood at close** — the live month always uses the current ones. */
  salary: storedMoneySchema,
  goal: storedMoneySchema,
  saved: storedMoneySchema,
  net: storedMoneySchema,
  verdict: z.enum(['hit', 'near', 'miss']),
  adapted: z.boolean(),
  entries: z.array(archivedEntrySchema),
  fixed: z.object({
    rent: storedMoneySchema,
    utilityLines: z.array(z.object({ id: z.string(), name: z.string(), amount: storedMoneySchema })),
  }),
  fxRateSetId: z.instanceof(ObjectId).nullable(),
  closedAt: z.date(),
});

export type MonthArchive = z.infer<typeof monthArchiveSchema>;
export type ArchivedEntry = z.infer<typeof archivedEntrySchema>;

const archives = () => collection<OptionalId<MonthArchive>>(COLLECTIONS.monthArchives);

function parse(document: unknown): MonthArchive {
  const result = monthArchiveSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', 'a month archive does not match its schema', {
      collection: COLLECTIONS.monthArchives,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * Every archived month key for a user, oldest first.
 *
 * Projected to the key alone, because the two callers that need this — the live-month rule and the
 * rollover's catch-up selection — need only the keys, and a month archive carries a full month of entries.
 */
export async function archivedMonthKeys(userId: ObjectId): Promise<string[]> {
  const documents = await archives()
    .find({ userId }, { projection: { monthKey: 1 }, sort: { monthKey: 1 } })
    .toArray();

  return documents.map((document) => {
    const { monthKey } = document as { monthKey?: unknown };
    if (typeof monthKey !== 'string') {
      throw new ApiError('INTERNAL', 'a month archive has no monthKey');
    }
    return monthKey;
  });
}

/** Whether a month is closed for a user. The `MONTH_CLOSED` check, and the rollover's "already done". */
export async function isArchived(userId: ObjectId, monthKey: string): Promise<boolean> {
  return (await archives().countDocuments({ userId, monthKey }, { limit: 1 })) > 0;
}

/** One archived month in full. */
export async function findArchive(userId: ObjectId, monthKey: string): Promise<MonthArchive | null> {
  const document = await archives().findOne({ userId, monthKey });
  return document === null ? null : parse(document);
}

/** Every archived month in full, newest first — what the Reports list is built from. */
export async function archivesForUser(userId: ObjectId): Promise<MonthArchive[]> {
  const documents = await archives().find({ userId }).sort({ monthKey: -1 }).toArray();
  return documents.map(parse);
}

export type NewArchive = Omit<MonthArchive, '_id'>;

/**
 * Write an archive, or report that one already existed.
 *
 * @returns `true` if this call wrote it, `false` if the unique index refused because it was already there.
 *
 * **`false` is the normal, expected outcome of a re-run**, not an error: rollover runs every fifteen
 * minutes with catch-up-safe selection, so most passes over a user find their month already archived.
 * Letting the index decide, rather than checking first, is what makes a retry mid-write safe — a
 * check-then-write has a race that a unique index does not.
 */
export async function insertArchive(archive: NewArchive): Promise<boolean> {
  try {
    await archives().insertOne(archive);
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** Erase every archive for a user. For the hard purge only — never for a correction. */
export async function deleteAllForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await archives().deleteMany({ userId });
  return deletedCount;
}
