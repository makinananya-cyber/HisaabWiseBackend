import { ObjectId, type OptionalId } from 'mongodb';
import { z } from 'zod';

import type { RateSet } from '../domain/money';
import { ApiError } from '../errors';
import { collection, COLLECTIONS, isDuplicateKeyError } from './collections';

/**
 * The `fx_rates` collection — one document per day, units per 1 USD.
 *
 * **A partial set is never written** (DATA_MODEL §3.6). A rate set missing twenty codes does not degrade
 * gracefully; it silently breaks the display currency of whoever picked one of those twenty, which is
 * indistinguishable from the rate-1.0 fallback Product Spec §4.1 forbids outright. So `writeRateSet`
 * refuses an incomplete set and the job that calls it alerts rather than writing something usable-looking.
 *
 * **An archived month pins the set it closed with** (`fxRateSetId`, invariant 7). That is why these
 * documents are never updated and never deleted: a report from March must convert through March's rates
 * forever, or a met goal could become a near miss because the rupee moved. Hence `_id` on the rate set —
 * an archive references it, so it needs an identity, not just a date.
 */

const rateSetSchema = z.object({
  _id: z.instanceof(ObjectId),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  base: z.literal('USD'),
  rates: z.record(z.string().length(3), z.number().positive()),
  fetchedAt: z.date(),
});

export type StoredRateSet = z.infer<typeof rateSetSchema>;

const rates = () => collection<OptionalId<StoredRateSet>>(COLLECTIONS.fxRates);

function parse(document: unknown): StoredRateSet {
  const result = rateSetSchema.safeParse(document);
  if (!result.success) {
    throw new ApiError('INTERNAL', undefined, {
      collection: COLLECTIONS.fxRates,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/** A stored document as the domain's `RateSet`, plus the id an archive would pin. */
export interface IdentifiedRateSet extends RateSet {
  readonly id: ObjectId;
}

const asRateSet = (stored: StoredRateSet): IdentifiedRateSet => ({
  id: stored._id,
  dateKey: stored.dateKey,
  base: stored.base,
  rates: stored.rates,
});

/**
 * The newest rate set, or `undefined` if none has been written.
 *
 * `undefined` rather than a throw, because a missing rate set is only a problem for a *conversion*, and
 * the common case — a reader whose display currency is the one they authored in — needs no rates at all.
 * `convert` is where the absence becomes an error, at the point it actually matters.
 */
export async function latestRateSet(): Promise<IdentifiedRateSet | undefined> {
  const document = await rates().findOne({}, { sort: { dateKey: -1 } });
  return document === null ? undefined : asRateSet(parse(document));
}

/** One rate set by id — what an archived month pins and reads back forever (invariant 7). */
export async function rateSetById(id: ObjectId): Promise<IdentifiedRateSet | undefined> {
  const document = await rates().findOne({ _id: id });
  return document === null ? undefined : asRateSet(parse(document));
}

/**
 * The set in force for a given day, or the newest one before it.
 *
 * "Or before" rather than an exact match: a missed `fx:refresh` run must not leave a day with no rates.
 * Reading yesterday's is a small, visible inaccuracy; failing is a screen that will not draw.
 */
export async function rateSetFor(dayKey: string): Promise<IdentifiedRateSet | undefined> {
  const document = await rates().findOne({ dateKey: { $lte: dayKey } }, { sort: { dateKey: -1 } });
  return document === null ? undefined : asRateSet(parse(document));
}

/**
 * Write one day's rates, refusing an incomplete set.
 *
 * @param requiredCodes every code the content lists. All must be present.
 * @returns the id of the written set, or `undefined` if a set for that day already existed — writing is
 * idempotent via the unique `dateKey` index, so a job that runs twice does not produce two versions of
 * one day's truth.
 *
 * @throws {ApiError} `INTERNAL` naming the missing codes. The caller alerts; it does not retry with what
 * it has.
 */
export async function writeRateSet(
  set: { dateKey: string; rates: Record<string, number> },
  requiredCodes: readonly string[],
  now: Date,
): Promise<ObjectId | undefined> {
  const missing = requiredCodes.filter((code) => !((set.rates[code] ?? 0) > 0));
  if (missing.length > 0) {
    throw new ApiError(
      'INTERNAL',
      `an incomplete rate set is not written: ${String(missing.length)} code(s) missing for ${set.dateKey}`,
      {
        dateKey: set.dateKey,
        missing,
        why: 'it would silently break the display currency of every user who picked one of these codes, which is the hardcoded fallback Product Spec §4.1 forbids',
      },
    );
  }

  try {
    const { insertedId } = await rates().insertOne({
      dateKey: set.dateKey,
      base: 'USD',
      rates: set.rates,
      fetchedAt: now,
    });
    return insertedId;
  } catch (err) {
    // Already have this day. Not an error: the set is a fact about a date, and two runs agree.
    if (isDuplicateKeyError(err)) return undefined;
    throw err;
  }
}

/** How many rate sets exist. For the seed script's "is this database already populated" check. */
export const countRateSets = async (): Promise<number> => rates().countDocuments();
