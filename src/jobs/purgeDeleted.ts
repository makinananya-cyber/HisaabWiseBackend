import { createHash } from 'node:crypto';

import type { Logger } from 'pino';

import * as events from '../repositories/events';
import * as entries from '../repositories/expenseEntries';
import * as fixedCosts from '../repositories/fixedCosts';
import * as learnProgress from '../repositories/learnProgress';
import * as archives from '../repositories/monthArchives';
import * as passwordResets from '../repositories/passwordResets';
import * as refreshTokens from '../repositories/refreshTokens';
import * as tombstones from '../repositories/tombstones';
import * as users from '../repositories/users';

/**
 * `purge:deleted` — the hard erase, thirty days after a soft delete.
 *
 * **Deletion is two stages, and the grace period is the point.** `DELETE /v1/me` sets `deletedAt`: sign-in is
 * blocked, the email stays reserved, and the account is recoverable — because "I deleted my finance app by
 * accident" is a real thing and an irreversible tap is a cruel one. Thirty days later this job erases every
 * document across every collection and releases the email.
 *
 * **What survives is a tombstone**, and only a hash of the user id. That is what makes erasure *evidenced*
 * rather than merely invisible: an operator asked "was this account erased?" can answer without keeping
 * anything about the person. The Technical Spec requires the tombstone in §6.4 and omitted it from its own
 * collection count; DATA_MODEL §3.10 counts it honestly.
 *
 * **The order matters.** Every dependent collection first, the user document last. A crash halfway leaves an
 * account still marked deleted with some data gone, and the next run finishes the job — whereas deleting the
 * user first would strand the rest with no `deletedAt` to find them by.
 */

/** Thirty days, per Product Spec §8 and App Store 5.1.1(v). */
export const GRACE_PERIOD_DAYS = 30;

export interface PurgeOutcome {
  readonly considered: number;
  readonly purged: number;
  readonly failed: number;
}

/**
 * Erase one account completely.
 *
 * @returns the number of documents removed, for the log. Not for the caller to act on — a purge that removed
 * nothing is a purge of an account that had nothing, which is a perfectly ordinary outcome.
 */
export async function purgeUser(userId: Parameters<typeof users.findById>[0], now: Date): Promise<number> {
  const user = await users.findById(userId);
  if (user === null) return 0;

  const id = user._id;

  // Dependents first, so a crash leaves an account that is still findable by `deletedAt` and finishable.
  const removed = [
    await entries.deleteAllForUser(id),
    await fixedCosts.deleteForUser(id),
    await archives.deleteAllForUser(id),
    await learnProgress.deleteForUser(id),
    await refreshTokens.deleteAllForUser(id),
    await passwordResets.deleteAllForUser(id),
    await events.deleteAllForUser(id),
  ].reduce((total, count) => total + count, 0);

  // Written before the user document goes, so the evidence exists even if the last delete fails. A
  // SHA-256 of the id: enough to answer "was this erased?", and nothing that identifies a person.
  await tombstones.record(createHash('sha256').update(id.toHexString()).digest('hex'), now);

  // Last. This is also what releases the email — the unique index stops refusing it.
  const deleted = await users.hardDelete(id);

  return removed + deleted;
}

/**
 * One pass over every account whose grace period has expired.
 *
 * Driven by the sparse `{deletedAt: 1}` index, so the query touches only the handful of deleted accounts
 * rather than scanning the table. Sequential, and one failure does not stop the pass — the same reasoning as
 * the rollover job.
 */
export async function runPurgeDeleted(logger: Logger, now: Date = new Date()): Promise<PurgeOutcome> {
  const cutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 86_400_000);
  const candidates = await users.deletedBefore(cutoff);

  let purged = 0;
  let failed = 0;

  for (const userId of candidates) {
    try {
      const removed = await purgeUser(userId, now);
      purged++;
      logger.warn(
        { userIdHash: createHash('sha256').update(userId.toHexString()).digest('hex').slice(0, 16), removed },
        'account purged after its grace period',
      );
    } catch (err) {
      failed++;
      logger.error({ err }, 'purge failed for one account');
    }
  }

  const outcome = { considered: candidates.length, purged, failed };
  if (purged > 0 || failed > 0) logger.info(outcome, 'purge pass complete');
  return outcome;
}
