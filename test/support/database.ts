import { randomBytes } from 'node:crypto';

import { closeDatabase, connectDatabase, getDb } from '../../src/db';
import { loadConfig, type Config } from '../../src/config';
import { loadContent } from '../../src/content';
import { createApp } from '../../src/index';
import { createLogger } from '../../src/logger';
import { COLLECTIONS } from '../../src/repositories/collections';
import { ensureIndexes } from '../../src/repositories/indexes';

/**
 * ADR-0014's test database, realised: a **per-run `hisaabwise_test_<runId>` database inside the same
 * Atlas cluster**, created at setup and dropped at teardown.
 *
 * **Why a real database and not a mocked repository.** The whole reason this project verified the native
 * driver against Atlas in the first place was that the platform's ability to talk to it was the central
 * unknown. Mocking the driver would test the mock. So these tests exercise the genuine driver-to-Atlas
 * path — including the unique indexes that two of the system's idempotency guarantees rest on, which a
 * mock cannot express at all.
 *
 * **Two guards, and they are the reason this is safe** (Rule 4). A destructive test must be
 * *structurally* incapable of reaching real user data, not merely careful:
 *
 *  1. Refuse if the URI looks like production.
 *  2. Refuse if the target database name does not carry `_test_`.
 *
 * The second is the one that does the work: `dropDatabase()` is called on teardown, and the only names
 * that can reach it are ones this file constructed.
 *
 * Domain tests stay pure and use none of this — money, budget, the security-answer normaliser, day keys.
 * Those are the highest-value tests in the codebase and they run in milliseconds.
 */

/** Raised when the environment is not one a destructive test may run against. */
class UnsafeTestDatabaseError extends Error {
  override readonly name = 'UnsafeTestDatabaseError';
}

/**
 * Names that mean "this is the real thing".
 *
 * Matched against the whole URI, so it catches a production cluster host as well as a production
 * database name. Deliberately broad: a false positive costs a developer one confusing message, and a
 * false negative costs real users their data.
 */
const PRODUCTION_MARKERS = ['prod', 'production', 'live'];

/** Replace the database name in a MongoDB URI, keeping the host, credentials and query string. */
function withDatabase(uri: string, database: string): string {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/]+\/)([^/?]*)(\?.*)?$/.exec(uri);
  if (match === null) {
    throw new UnsafeTestDatabaseError(
      'MONGODB_URI must name a database in its path before a test database can be derived from it.',
    );
  }
  return `${match[1] ?? ''}${database}${match[3] ?? ''}`;
}

function assertSafe(uri: string, database: string): void {
  const lowered = uri.toLowerCase();
  const marker = PRODUCTION_MARKERS.find((candidate) => lowered.includes(candidate));
  if (marker !== undefined) {
    throw new UnsafeTestDatabaseError(
      `MONGODB_URI contains "${marker}", so it may address production. The test suite drops the ` +
        'database it connects to and will not run against it (workspace Rule 4).',
    );
  }

  // The guard that actually protects the data: teardown drops this database by name.
  if (!database.includes('_test_')) {
    throw new UnsafeTestDatabaseError(
      `refusing to run against "${database}": a test database name must contain "_test_". This is ` +
        'the guard that makes dropDatabase() on teardown safe.',
    );
  }
}

/** One test run's database and the app wired onto it. */
export interface TestDatabase {
  readonly config: Config;
  readonly app: ReturnType<typeof createApp>;
  readonly databaseName: string;
  /**
   * Empty every collection without dropping the database, so the indexes survive.
   *
   * **Call this once per suite, not once per test.** Isolation between tests comes from each one
   * creating its own user, not from truncation — and calling this per test was measured at the dominant
   * cost of the auth suite: a `collections()` listing plus a `deleteMany` per collection is a dozen
   * round trips to Atlas, and issuing them in parallel opened enough simultaneous connections to make
   * the TLS handshakes themselves time out.
   */
  clear(): Promise<void>;
  drop(): Promise<void>;
}

/**
 * Whether the environment can support an integration test at all.
 *
 * Exported so a suite can `describe.skipIf` on it rather than failing: the pure domain suites must run on
 * a machine with no credentials, and a developer who has not filled in `.env` should get a skip with a
 * reason, not a wall of connection errors. CI has the secret, so nothing is silently unverified there.
 */
export const canReachDatabase = (): boolean => (process.env.MONGODB_URI ?? '') !== '';

export const skipReason =
  'MONGODB_URI is not set — integration tests need the dev/staging Atlas database (ADR-0014).';

/**
 * Connect a fresh per-run database and build an app around it.
 *
 * The run id is random rather than a timestamp, so two suites starting in the same millisecond cannot
 * collide, and a crashed run leaves an obviously-orphaned `hisaabwise_test_*` behind rather than a name
 * a later run might reuse.
 */
export async function setupDatabase(): Promise<TestDatabase> {
  const baseUri = process.env.MONGODB_URI;
  if (baseUri === undefined || baseUri === '') throw new UnsafeTestDatabaseError(skipReason);

  const databaseName = `hisaabwise_test_${randomBytes(6).toString('hex')}`;
  const uri = withDatabase(baseUri, databaseName);
  assertSafe(uri, databaseName);

  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    LOG_LEVEL: 'silent',
    // Deterministic and long enough for the schema's 32-character minimum. A real secret here would be
    // a real secret in a test log.
    JWT_ACCESS_SECRET: 'test-only-access-secret-not-for-any-deployment',
    // The lowest argon2 cost the schema permits. The *parameters* are asserted in their own unit test;
    // paying 19 MiB and 20 ms per hash across a suite that registers dozens of users buys nothing and
    // makes the suite slow enough that someone eventually deletes it.
    ARGON2_MEMORY_KIB: '8192',
    ARGON2_TIME_COST: '2',
  });

  const logger = createLogger(config);
  await connectDatabase(config);
  await ensureIndexes(logger);
  loadContent();

  return {
    config,
    app: createApp(config, logger),
    databaseName,

    async clear() {
      // A fixed list, cleared in sequence. Listing the collections first would be an extra round trip
      // for information already known, and clearing in parallel is what saturated the pool.
      for (const name of Object.values(COLLECTIONS)) {
        await getDb().collection(name).deleteMany({});
      }
    },

    async drop() {
      // Safe because `assertSafe` above is the only path to this name.
      await getDb().dropDatabase();
      await closeDatabase();
    },
  };
}
