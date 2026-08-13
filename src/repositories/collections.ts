import type { Collection, Document } from 'mongodb';

import { getDb } from '../db';

/**
 * The collection names, in one place, and the typed handles onto them.
 *
 * **Nine collections plus a tombstone** (DATA_MODEL §3). `email_verifications` is not among them —
 * email verification was dropped and `emailVerified` stays in the contract, always true. `content` is
 * not among them either: editorial content is static and served from disk (ADR-0008).
 *
 * Names are a `const` object rather than string literals at each call site because a typo in a
 * collection name does not fail — it silently creates an empty collection and reads nothing from it,
 * which is the quietest possible bug.
 *
 * Everything in this directory is the sanctioned home for `getDb()`; the `no-restricted-imports` lint
 * rule in `eslint.config.mjs` is what keeps it that way (invariant 1, ADR-0002).
 */
export const COLLECTIONS = {
  users: 'users',
  expenseEntries: 'expense_entries',
  fixedCosts: 'fixed_costs',
  monthArchives: 'month_archives',
  learnProgress: 'learn_progress',
  fxRates: 'fx_rates',
  refreshTokens: 'refresh_tokens',
  passwordResets: 'password_resets',
  events: 'events',
  deletionTombstones: 'deletion_tombstones',
} as const;

/** A typed handle on one collection. */
export const collection = <Doc extends Document>(name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS]): Collection<Doc> =>
  getDb().collection<Doc>(name);

/**
 * Whether a write failed because it collided with a unique index.
 *
 * **Two of this system's guarantees rest on that collision rather than on a lookup-then-write**
 * (DATA_MODEL §4): the client-supplied UUID `_id` on an expense entry is the idempotency mechanism for
 * a replayed create, and the unique `(userId, monthKey)` index on `month_archives` is what makes the
 * rollover job safe to retry. A check-then-insert would have a race between the two; letting the index
 * refuse the second write does not.
 *
 * Duck-typed on `code` rather than `instanceof MongoServerError`, because a driver wrapping the error —
 * in a transaction, or in a bulk write — changes the class and not the code.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
