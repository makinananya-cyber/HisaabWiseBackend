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
    // Named so the Atlas connection view attributes connections to this service.
    appName: 'hisaabwise-backend',
  };
}

/** Process scope, deliberately: created once at startup, shared by every request. */
let client: MongoClient | undefined;

/**
 * Connect the shared client. Called once from the server entrypoint, before the first request is
 * accepted, so a database that cannot be reached is a failure to boot rather than a failure to
 * serve.
 */
export async function connectDatabase(config: Config): Promise<MongoClient> {
  client ??= new MongoClient(config.MONGODB_URI, clientOptions(config));
  await client.connect();
  return client;
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
