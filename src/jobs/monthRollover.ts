import type { AppLogger } from '../logging';

import { computeBudget } from '../domain/budget';
import { convert } from '../domain/money';
import { monthKey, nextMonthKey } from '../domain/time';
import * as entries from '../repositories/expenseEntries';
import * as fixedCosts from '../repositories/fixedCosts';
import { latestRateSet, type IdentifiedRateSet } from '../repositories/fxRates';
import * as archives from '../repositories/monthArchives';
import * as users from '../repositories/users';
import { monthTotals } from '../screens/expenses';

/**
 * `month:rollover` — **the most dangerous code in the system.**
 *
 * At each user's *local* month boundary the live month closes, is snapshotted immutably into Reports, and
 * the live month resets: `log` entries cleared, rent and utility lines **carried forward unchanged**.
 *
 * Four properties, and each one is a way this could go wrong instead:
 *
 * **1 — Selection is catch-up-safe.** The rule is `the user's previous local month has passed AND no
 * archive exists for (userId, monthKey)` — never "crossed in the last hour". A run that is skipped, a
 * deploy that takes the process down over midnight, or a machine that sleeps must not lose a month, and
 * with this rule a late run archives the missed month exactly as an on-time one would.
 *
 * **2 — Idempotency is the unique index, not a check.** `insertArchive` lets `(userId, monthKey)` refuse a
 * second write. A check-then-write has a race between the check and the write; an index does not. So
 * running twice writes once, and that is enforced by the database rather than by this file remembering.
 *
 * **3 — The archive is written before the month is cleared, and the clear is driven by the archive.** The
 * order matters: if the process dies in between, nothing has been lost, only not yet tidied. But the clear
 * cannot be conditional on a month being *due*, because once the archive exists the month is no longer due —
 * so a crash in that window would leave the entries orphaned forever, in a month too closed to delete them
 * from. Instead, every pass deletes entries belonging to **any** already-archived month. That is idempotent,
 * costs one indexed `deleteMany`, and makes the crash window self-healing on the next run whenever it
 * happened. (This is the bug the rollover suite found: the first version cleared only the month it had just
 * archived.)
 *
 * **4 — Per-user, so one user's failure is one user's retry.** The fan-out was never really about CPU
 * limits; it is what gives per-user retries on a job that writes immutable history, and the unique index
 * is what makes those retries safe.
 *
 * Runs every **15 minutes** rather than hourly: timezone offsets are not all whole hours (Asia/Kolkata
 * +05:30, Asia/Kathmandu +05:45, Pacific/Chatham +12:45), and India is squarely in the target market.
 * Catch-up-safe selection makes the extra runs no-ops, so the granularity is nearly free.
 */

export interface RolloverOutcome {
  readonly considered: number;
  readonly archived: number;
  readonly alreadyArchived: number;
  /** Passes that wrote no archive but tidied entries left behind by an interrupted earlier pass. */
  readonly tidied: number;
  readonly failed: number;
}

/** What one user's pass did. */
export type UserRolloverOutcome =
  /** A month was closed by this pass. */
  | 'archived'
  /** A concurrent pass wrote the archive first. Only reachable when two instances race. */
  | 'alreadyArchived'
  /** Nothing was due, but entries from an already-archived month were still present and were removed. */
  | 'tidied'
  | 'nothingDue';

/**
 * The month a user should have archived by now, or `undefined` if there is nothing to close.
 *
 * The month *before* their current local one: while a user is still inside August, August is live and
 * nothing is due. The moment their local clock reaches September, August is due — and stays due until an
 * archive exists for it, which is what makes a late run correct rather than merely tolerable.
 */
export function monthDueFor(user: users.User, now: Date, archivedKeys: readonly string[]): string | undefined {
  const currentLocal = monthKey(now, user.timezone);

  // Nothing to close before the account existed. Without this, a user who registered today would have
  // every month since the epoch "due".
  const firstMonth = monthKey(user.createdAt, user.timezone);

  const archived = new Set(archivedKeys);
  let candidate = firstMonth;

  // Walk forward from the first month the account existed to the one before the current local month, and
  // return the earliest that has not been archived. Walking rather than jumping to "the previous month" is
  // what closes a *gap*: a user away for three months has three months to file, oldest first.
  while (candidate < currentLocal) {
    if (!archived.has(candidate)) return candidate;
    candidate = nextMonthKey(candidate);
  }

  return undefined;
}

/**
 * Close one month for one user.
 *
 * Two steps, and the second runs whether or not the first did: write the archive for whatever month is due,
 * then remove live entries for **every** archived month. See property 3 in the module docstring for why the
 * clear is not conditional on the archive having just been written.
 */
export async function rolloverUser(
  user: users.User,
  now: Date,
  rates: IdentifiedRateSet | undefined,
  logger: AppLogger,
): Promise<UserRolloverOutcome> {
  const archivedKeys = await archives.archivedMonthKeys(user._id);
  const due = monthDueFor(user, now, archivedKeys);

  if (due === undefined) {
    // Nothing to close. Still sweep: an earlier pass may have written an archive and died before clearing,
    // and those entries are now in a month too closed to delete from by any other route.
    const tidied = await entries.deleteArchivedMonths(user._id, archivedKeys);
    if (tidied > 0) {
      logger.warn(
        { userId: user._id.toHexString(), entries: tidied },
        'removed live entries left in an already-archived month by an interrupted pass',
      );
      return 'tidied';
    }
    return 'nothingDue';
  }

  const currency = user.displayCurrency;
  const [monthEntries, fixed] = await Promise.all([
    entries.entriesForMonth(user._id, due),
    fixedCosts.forUser(user._id, currency),
  ]);

  // **Sealed in the authored currency, converted at read.** The archive stores the figures as they were,
  // and `fxRateSetId` pins how they convert forever (invariant 7).
  const totals = monthTotals(monthEntries, fixed, currency, rates);
  const salary = convert(user.salary, currency, rates);
  const goal = convert(user.savingsGoal, currency, rates);

  const budget = computeBudget({
    income: { ...salary, minor: salary.minor + totals.additionalIncome.minor },
    needs: totals.needs,
    wantsSpent: totals.wantsSpent,
    goal,
  });

  const wrote = await archives.insertArchive({
    userId: user._id,
    monthKey: due,
    // Salary and goal **as they stood at close**. The live month always uses the current ones; the archive
    // pins these, so a later raise does not rewrite history (Product Spec §4.2).
    salary,
    goal,
    // The four figures that are the month's *story*, sealed rather than recomputed (defect D6).
    saved: budget.saved,
    net: budget.net,
    verdict: budget.verdict,
    adapted: budget.adapted,
    entries: monthEntries.map((entry) => ({
      id: entry._id,
      category: entry.category,
      amount: entry.amount,
      label: entry.label,
      // A **full** timestamp. The prototype stored a day-of-month, which cannot order two entries in a day.
      entryDate: entry.entryDate,
    })),
    fixed: { rent: fixed.rent, utilityLines: fixed.utilityLines },
    fxRateSetId: rates?.id ?? null,
    closedAt: now,
  });

  // **After** the archive is written, and driven by the archive rather than by what was due — so this is
  // also the path that tidies up after an interrupted pass.
  const cleared = await entries.deleteArchivedMonths(user._id, [...archivedKeys, due]);

  if (!wrote) {
    // A concurrent pass wrote it first. Not an error: the unique index did its job, and the clear above
    // still ran, so the outcome is the same either way.
    logger.debug({ userId: user._id.toHexString(), monthKey: due }, 'month already archived by a concurrent pass');
    return 'alreadyArchived';
  }

  // Rent and utility lines are **carried forward unchanged** by doing nothing: they live on their own
  // document, not on the month's, so the next month inherits them without a copy. That is exactly why they
  // are a separate collection from the append-only log.
  logger.info(
    { userId: user._id.toHexString(), monthKey: due, entries: cleared, verdict: budget.verdict },
    'month archived',
  );
  return 'archived';
}

/**
 * One pass over every user.
 *
 * Sequential rather than parallel: the pool is shared with live traffic, and a burst of concurrent writes
 * from a background job is exactly the way to make a user's request time out. Every fifteen minutes is
 * ample for a per-user walk.
 *
 * A failure on one user is logged and the pass continues. That is the fan-out's whole point — one user's
 * bad document must not stop the other thousand from filing.
 */
export async function runMonthRollover(logger: AppLogger, now: Date = new Date()): Promise<RolloverOutcome> {
  const rates = await latestRateSet();
  const candidates = await users.activeUserIds();

  let archived = 0;
  let alreadyArchived = 0;
  let tidied = 0;
  let failed = 0;

  for (const userId of candidates) {
    try {
      const user = await users.findById(userId);
      if (user?.deletedAt !== null) continue;

      const outcome = await rolloverUser(user, now, rates, logger);
      if (outcome === 'archived') archived++;
      if (outcome === 'alreadyArchived') alreadyArchived++;
      if (outcome === 'tidied') tidied++;
    } catch (err) {
      failed++;
      logger.error({ err, userId: userId.toHexString() }, 'month rollover failed for one user');
    }
  }

  const outcome = { considered: candidates.length, archived, alreadyArchived, tidied, failed };
  if (archived > 0 || tidied > 0 || failed > 0) logger.info(outcome, 'month rollover pass complete');
  return outcome;
}

