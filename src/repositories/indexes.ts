import type { Logger } from 'pino';

import { collection, COLLECTIONS } from './collections';

/**
 * Every index, created idempotently at startup, so a fresh database and a migrated one converge.
 *
 * **No migration framework at launch** (DATA_MODEL §5): nine collections, none of them yet carrying
 * production data, and `createIndexes` is already idempotent. A framework would be machinery for a
 * problem that does not exist.
 *
 * **Two of these are not optimisations.** The unique `(userId, monthKey)` on `month_archives` is the
 * idempotency backbone of the month-rollover job — it is what makes a retry safe to run rather than
 * something to reason about — and the unique `_id` on `expense_entries`, which MongoDB provides for
 * free, is the idempotency mechanism for a replayed expense create (ADR-0011). The system relies on
 * those two collisions *instead of* an idempotency-key collection.
 *
 * Called from the entrypoint after the pool connects and before the port is bound: an index that failed
 * to build is a deploy that should not serve, because the guarantees above would silently not hold.
 */
export async function ensureIndexes(logger: Logger): Promise<void> {
  const built: string[] = [];

  // ── Slice 2 — identity ──────────────────────────────────────────────────────────────────────
  built.push(
    ...(await collection(COLLECTIONS.users).createIndexes([
      // Email is the identity (invariant 4). Unique, and it is this index — not a prior lookup — that
      // refuses a duplicate registration, so two racing signups cannot both succeed.
      { key: { email: 1 }, unique: true, name: 'email_unique' },
      // Drives `purge:deleted`. Sparse because the overwhelming majority of users are not deleted, and
      // an index over 200,000 nulls to find four documents is wasted space.
      { key: { deletedAt: 1 }, sparse: true, name: 'deletedAt_sparse' },
    ])),
  );

  built.push(
    ...(await collection(COLLECTIONS.refreshTokens).createIndexes([
      // Lookup is always by hash — the plaintext token is never stored.
      { key: { tokenHash: 1 }, unique: true, name: 'tokenHash_unique' },
      // Family revocation: the query that runs when a revoked token is presented.
      { key: { familyId: 1 }, name: 'familyId' },
      { key: { userId: 1 }, name: 'userId' },
      // MongoDB deletes expired tokens for us. `expireAfterSeconds: 0` means "at the time in the
      // field", which is what makes a 60-day token clean itself up without a job.
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'expiresAt_ttl' },
    ])),
  );

  built.push(
    ...(await collection(COLLECTIONS.passwordResets).createIndexes([
      { key: { ticketHash: 1 }, unique: true, name: 'ticketHash_unique' },
      { key: { userId: 1 }, name: 'userId' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'expiresAt_ttl' },
    ])),
  );

  // ── Slice 3 — money ─────────────────────────────────────────────────────────────────────────
  built.push(
    ...(await collection(COLLECTIONS.fxRates).createIndexes([
      // One document per day, and the index is what makes writing idempotent: a job that runs twice
      // does not produce two versions of one day's truth.
      { key: { dateKey: 1 }, unique: true, name: 'dateKey_unique' },
    ])),
  );

  logger.info({ indexes: built.length }, 'indexes ensured');
}
