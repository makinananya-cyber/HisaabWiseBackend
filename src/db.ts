import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

import type { Config } from './config';

/**
 * The only module that constructs a MongoDB client.
 *
 * **The driver is the native one, speaking the wire protocol to Atlas directly** — no HTTP shim,
 * no Data API, no proxy.
 *
 * **One client, one pool, for the life of the process** (invariant 9). The invariant was written
 * against Cloudflare Workers, where `maxPoolSize: 1` was the mechanism because each ephemeral
 * isolate would otherwise open its own connection and exhaust Atlas's ceiling. On a long-lived
 * Node process the *end* — a hard bound on connections, never one per operation — is served by a
 * single warm pool with a configured ceiling, which is strictly better: connections are reused
 * across requests instead of being re-established.
 *
 * If Atlas connection counts climb unexpectedly, lower `MONGODB_MAX_POOL_SIZE` before reaching
 * for anything cleverer.
 */

function clientOptions(config: Config): MongoClientOptions {
  return {
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
    minPoolSize: 0,
    // A connection idle this long is one Atlas should get back.
    maxIdleTimeMS: 60_000,
    // Bounded so an unreachable cluster fails honestly rather than hanging, but not as tight as
    // it looks. Measured: a cold `mongodb+srv://` connect to this Atlas cluster from the UAE takes
    // **~3 s** — SRV lookup, TXT lookup, then a TLS handshake to each of three replica-set members
    // at ~1s apiece. An earlier 5 s bound left only 2 s of headroom and failed intermittently, so
    // this is set from that measurement rather than from taste.
    //
    // It costs `/health/db` nothing: this budget is spent on the *cold* connect at boot, and by
    // the time requests arrive the pool is warm and server selection is immediate.
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  };
}

/** Process scope, deliberately: created once at startup, shared by every request. */
let client: MongoClient | undefined;

export interface ConnectOptions {
  /** Total attempts, including the first. */
  readonly attempts?: number;
  /** First backoff, doubling each attempt, capped at 8s. */
  readonly baseDelayMs?: number;
  readonly onRetry?: (detail: { attempt: number; attempts: number; delayMs: number; err: unknown }) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The backoff schedule: doubling from `baseDelayMs`, capped at 8s, one entry per *gap* between
 * attempts — so three attempts produce two waits.
 *
 * Pure and exported so the policy can be tested without a network. The alternative, asserting the
 * schedule by watching real connection attempts, would cost the connect timeout per attempt and
 * make the suite slow enough that someone eventually deletes it.
 */
export function retryDelays(attempts: number, baseDelayMs: number): number[] {
  return Array.from({ length: Math.max(0, attempts - 1) }, (_unused, index) =>
    Math.min(baseDelayMs * 2 ** index, 8_000),
  );
}

/**
 * Connect the shared client, retrying a transient failure with backoff.
 *
 * Called once from the entrypoint before any request is accepted, so a database that cannot be
 * reached is a failure to boot rather than a failure to serve.
 *
 * **Why retry at all**, when the whole point of connecting first is to fail fast: the two are not
 * in tension. Reaching this Atlas cluster is measurably flaky — a cold connect costs ~3s across
 * three TLS handshakes, and one of them intermittently comes back `ECONNRESET`. A single attempt
 * turns a two-second network hiccup into a failed deploy, which is a worse failure than the one
 * fail-fast exists to prevent. After the last attempt it still throws, so a genuinely unreachable
 * cluster still stops the boot.
 *
 * A fresh client per attempt, because a `MongoClient` whose first connect failed can be left with
 * a poisoned topology; reusing it would retry into the same broken state.
 */
export async function connectDatabase(
  config: Config,
  { attempts = 5, baseDelayMs = 500, onRetry }: ConnectOptions = {},
): Promise<MongoClient> {
  const delays = retryDelays(attempts, baseDelayMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const candidate = new MongoClient(config.MONGODB_URI, clientOptions(config));
    try {
      await candidate.connect();
      client = candidate;
      return client;
    } catch (err) {
      lastError = err;
      await candidate.close().catch(() => undefined);

      const delayMs = delays[attempt - 1];
      if (delayMs === undefined) break;

      onRetry?.({ attempt, attempts, delayMs, err });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * The shared client.
 *
 * @throws when called before `connectDatabase`. That is a programming error rather than an
 * operational one — it means something reached for the database outside the request lifecycle.
 */
export function getMongoClient(): MongoClient {
  if (!client) {
    throw new Error(
      'The database client has not been connected. Call connectDatabase() from the entrypoint ' +
        'before serving requests.',
    );
  }
  return client;
}

/** The application database — the one named in the connection string, never chosen here. */
export function getDb(): Db {
  return getMongoClient().db();
}

/** Round-trip the database to prove it is reachable *now*. */
export async function pingDatabase(): Promise<void> {
  await getDb().command({ ping: 1 });
}

/** Close the pool. For graceful shutdown and for test teardown. */
export async function closeDatabase(): Promise<void> {
  await client?.close();
  client = undefined;
}
