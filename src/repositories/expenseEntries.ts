import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { ApiError } from '../errors';
import { storedMoneySchema, type Money } from '../types/money';
import { collection, COLLECTIONS, isDuplicateKeyError } from './collections';

/**
 * The `expense_entries` collection — append-only, one document per logged entry.
 *
 * **The client-supplied UUID `_id` is the idempotency mechanism** (ADR-0011). MongoDB's unique `_id`
 * index makes a create idempotent for free: a duplicate insert raises `E11000`, which the route reports
 * as "already recorded" rather than filing the entry twice. That is why there is no `idempotency_keys`
 * collection, and why this is better than one — a key store has a TTL, and after it expires a very stale
 * retry double-writes anyway. An `_id` has no expiry.
 *
 * **`monthKey` is server-derived and frozen** (DATA_MODEL §3.2). It comes from `entryDate` in the user's
 * stored timezone *at write time* and is never recomputed, so a later timezone change cannot re-file
 * existing history. A client-supplied `monthKey` is never trusted, because a client that could choose one
 * could write into a closed month.
 */

/** The five `log` categories. `income` is the only `flow: "in"` one — it is *additional* income. */
export const LOG_CATEGORIES = ['groceries', 'transport', 'entertainment', 'other', 'income'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

const entrySchema = z.object({
  /** A UUID string, not an ObjectId — the client mints it, and it is the idempotency key. */
  _id: z.string().min(1),
  userId: z.instanceof(ObjectId),
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  category: z.enum(LOG_CATEGORIES),
  amount: storedMoneySchema,
  /** The pick-list option's *name*, or free text. What the entry row shows. */
  label: z.string(),
  /** A full timestamp, not a day-of-month: two entries on one day have to be orderable. */
  entryDate: z.date(),
  createdAt: z.date(),
});

export type ExpenseEntry = z.infer<typeof entrySchema>;

const entries = () => collection<OptionalId<ExpenseEntry>>(COLLECTIONS.expenseEntries);

function parse(document: unknown): ExpenseEntry {
  const result = entrySchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', `an expense entry does not match its schema`, {
      collection: COLLECTIONS.expenseEntries,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

export interface NewEntry {
  readonly id: string;
  readonly userId: ObjectId;
  readonly monthKey: string;
  readonly category: LogCategory;
  readonly amount: Money;
  readonly label: string;
  readonly entryDate: Date;
}

/**
 * Insert one entry.
 *
 * @throws {ApiError} `ALREADY_RECORDED` when the id already exists. The route turns that into a success
 * carrying the current screen — a replayed create must not double-count, and must not look like a failure
 * to a client that simply lost the first response.
 */
export async function insertEntry(entry: NewEntry, now: Date): Promise<void> {
  try {
    await entries().insertOne({
      _id: entry.id,
      userId: entry.userId,
      monthKey: entry.monthKey,
      category: entry.category,
      amount: entry.amount,
      label: entry.label,
      entryDate: entry.entryDate,
      createdAt: now,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ApiError('ALREADY_RECORDED');
    throw err;
  }
}

/** Every entry for one user in one month, newest first — the order the screen draws them. */
export async function entriesForMonth(userId: ObjectId, monthKey: string): Promise<ExpenseEntry[]> {
  const documents = await entries()
    .find({ userId, monthKey })
    // `entryDate` first because that is what the reader sees; `_id` breaks a tie so the order is stable
    // between two reads of the same month, which an unstable sort would not guarantee.
    .sort({ entryDate: -1, _id: -1 })
    .toArray();

  return documents.map(parse);
}

/**
 * Delete one entry, scoped to its owner.
 *
 * The `userId` in the filter is not belt and braces: the id comes from a payload the client was given, and
 * a filter on `_id` alone would let a guessed or leaked UUID delete somebody else's entry.
 *
 * @returns whether anything was deleted. A miss is reported rather than thrown, so the route can answer
 * `404` for an unknown id and the caller can tell it apart from a permission problem.
 */
export async function deleteEntry(userId: ObjectId, id: string): Promise<boolean> {
  const { deletedCount } = await entries().deleteOne({ _id: id, userId });
  return deletedCount === 1;
}

/** One entry by id, scoped to its owner. Used to check the month before deleting from a closed one. */
export async function findEntry(userId: ObjectId, id: string): Promise<ExpenseEntry | null> {
  const document = await entries().findOne({ _id: id, userId });
  return document === null ? null : parse(document);
}

/** Erase every entry for a user. For the hard purge, and for the rollover's clear-the-live-month step. */
export async function deleteAllForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await entries().deleteMany({ userId });
  return deletedCount;
}

/** Erase one month's entries for a user. */
export async function deleteMonth(userId: ObjectId, monthKey: string): Promise<number> {
  const { deletedCount } = await entries().deleteMany({ userId, monthKey });
  return deletedCount;
}

/**
 * Erase entries belonging to any of the given months — what rollover calls once the archive exists.
 *
 * **Driven by which months are archived, not by which month was just closed.** An archive is the proof that
 * a month's entries are safe to remove, so sweeping every archived month makes the clear idempotent *and*
 * self-healing: a pass that wrote an archive and then died leaves entries in a month that is no longer
 * "due", and nothing else would ever remove them — they would sit in a month too closed to delete from.
 *
 * A no-op for an empty list, which is the common case.
 */
export async function deleteArchivedMonths(
  userId: ObjectId,
  archivedMonthKeys: readonly string[],
): Promise<number> {
  if (archivedMonthKeys.length === 0) return 0;
  const { deletedCount } = await entries().deleteMany({
    userId,
    monthKey: { $in: [...archivedMonthKeys] },
  });
  return deletedCount;
}
