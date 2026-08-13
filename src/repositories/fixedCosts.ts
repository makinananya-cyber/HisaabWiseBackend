import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import { ApiError } from '../errors';
import { money, storedMoneySchema, type Money } from '../types/money';
import { collection, COLLECTIONS } from './collections';

/**
 * The `fixed_costs` collection — one document per user, holding the two non-`log` category kinds.
 *
 * **`fixed` and `lines` are edited in place, not appended to** (DATA_MODEL §2). Rent is one amount;
 * utilities are a small set of named recurring amounts. Both are **carried forward unchanged at
 * rollover**, which is the whole reason they are a separate collection from `expense_entries`: an
 * append-only log cannot express "the same rent, next month" without duplicating a row every month.
 */

const utilityLineSchema = z.object({
  /** Stable across edits, so a line's identity survives a rename. */
  id: z.string().min(1),
  name: z.string().min(1),
  amount: storedMoneySchema,
});

export type UtilityLine = z.infer<typeof utilityLineSchema>;

const fixedCostsSchema = z.object({
  userId: z.instanceof(ObjectId),
  rent: storedMoneySchema,
  utilityLines: z.array(utilityLineSchema),
  updatedAt: z.date(),
});

export type FixedCosts = z.infer<typeof fixedCostsSchema>;

const fixedCosts = () => collection<OptionalId<FixedCosts>>(COLLECTIONS.fixedCosts);

function parse(document: unknown): FixedCosts {
  const result = fixedCostsSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', 'a fixed-costs document does not match its schema', {
      collection: COLLECTIONS.fixedCosts,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * A user's fixed costs, or an empty set in their display currency.
 *
 * **Empty rather than null**, because "no document yet" and "rent of zero" are the same screen: a new user
 * has a Rent row reading zero with a tap to set it. Returning null would push that decision into every
 * caller, and one of them would eventually get it wrong.
 */
export async function forUser(userId: ObjectId, currency: string): Promise<FixedCosts> {
  const document = await fixedCosts().findOne({ userId });
  if (document === null) {
    return { userId, rent: money(0, currency), utilityLines: [], updatedAt: new Date(0) };
  }
  return parse(document);
}

/** Set the rent. Upserts, so a first edit needs no prior document. */
export async function setRent(userId: ObjectId, rent: Money, now: Date): Promise<void> {
  await fixedCosts().updateOne(
    { userId },
    { $set: { rent, updatedAt: now }, $setOnInsert: { utilityLines: [] } },
    { upsert: true },
  );
}

/**
 * Replace the whole set of utility lines.
 *
 * One request for the whole set rather than per-line writes, because that is the gesture the design has —
 * the reader edits a card of bills and saves it. Replacing rather than merging also means a deleted line is
 * expressible, which a per-line `PUT` cannot do.
 */
export async function setUtilityLines(
  userId: ObjectId,
  utilityLines: UtilityLine[],
  currency: string,
  now: Date,
): Promise<void> {
  await fixedCosts().updateOne(
    { userId },
    { $set: { utilityLines, updatedAt: now }, $setOnInsert: { rent: money(0, currency) } },
    { upsert: true },
  );
}

/** Erase a user's fixed costs. For the hard purge. */
export async function deleteForUser(userId: ObjectId): Promise<number> {
  const { deletedCount } = await fixedCosts().deleteOne({ userId });
  return deletedCount;
}
