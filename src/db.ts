import type { MongoClient, MongoClientOptions } from 'mongodb';
import { z } from 'zod';

/**
 * The only module that constructs a MongoDB client.
 *
 * Two things here are load-bearing rather than incidental:
 *
 * **The driver is the native one, speaking the MongoDB wire protocol to Atlas directly** — no
 * HTTP shim, no Data API, no proxy. That works on Workers because `nodejs_compat_v2` with a
 * compatibility date of 2025-03-20 or later supplies `node:net` and `node:tls`/`TLSSocket`.
 * The Technical Spec §1 claim that the driver is not viable on Workers predates those and does
 * not apply. Lowering either setting in `wrangler.toml` breaks this file.
 *
 * **The client is constructed once per isolate and reused** (workspace invariant 9). Worker
 * isolates are ephemeral and Atlas has a hard connection ceiling, so a client per request —
 * or worse, a connection per operation — exhausts the ceiling precisely under the load where
 * that matters most. The pool is capped at one connection with a minimum of zero.
 *
 * If Atlas connection counts still climb under load, the escalation is a Durable Object acting
 * as a connection broker, not retries.
 */

/**
 * The database configuration this module needs, validated at the runtime boundary.
 *
 * `MONGODB_URI` is a secret, so it is never in `wrangler.toml` and therefore never in the
 * `Env` that `wrangler types` generates. That means it cannot be typed into existence — it has
 * to be *checked*, which is why callers pass `unknown` and this schema is the gate.
 */
const databaseEnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
});

/** Thrown when `MONGODB_URI` is absent or empty. Fail fast, with a message that says what to do. */
export class DatabaseNotConfiguredError extends Error {
  override readonly name = 'DatabaseNotConfiguredError';

  constructor(options?: { cause: unknown }) {
    super(
      'MONGODB_URI is not configured. Locally, copy .dev.vars.example to .dev.vars and set it ' +
        '(never to a production URI). For a deployed environment, set it with ' +
        '`wrangler secret put MONGODB_URI --env <staging|production>`.',
      options,
    );
  }
}

/**
 * Connection options. Not configurable: these encode invariant 9, and the point of a cap is
 * that it cannot be raised casually.
 */
const clientOptions = {
  // One connection per isolate, and none held open when idle.
  maxPoolSize: 1,
  minPoolSize: 0,
  // An isolate is short-lived, so a connection idle this long is one Atlas should get back
  // rather than one this isolate is still likely to need.
  maxIdleTimeMS: 60_000,
  // Bounded so an unreachable cluster surfaces as a fast, honest failure. The default 30s
  // would leave `/health/db` — an endpoint whose entire purpose is to answer *now* — hanging.
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 5_000,
  // Named so the Atlas connection view attributes connections to this service.
  appName: 'hisaabwise-backend',
} as const satisfies MongoClientOptions;

/**
 * Module scope, deliberately. This survives for the lifetime of the isolate and is shared by
 * every request that isolate handles. A promise rather than a client so that two requests
 * arriving together on a cold isolate cannot each construct one.
 */
let clientPromise: Promise<MongoClient> | undefined;
let clientsCreated = 0;

/** What this isolate has actually done, plus the caps it is doing it under. */
export interface ConnectionDiagnostics {
  /** MongoClient instances this isolate has constructed. Zero until first use, then one, forever. */
  readonly clientsCreated: number;
  readonly maxPoolSize: number;
  readonly minPoolSize: number;
}

export function connectionDiagnostics(): ConnectionDiagnostics {
  return {
    clientsCreated,
    maxPoolSize: clientOptions.maxPoolSize,
    minPoolSize: clientOptions.minPoolSize,
  };
}

/**
 * The driver is loaded on demand rather than at module scope.
 *
 * Requests that never touch the database — `/health`, and later every content route — then
 * never pay to evaluate it, which is startup CPU an isolate would otherwise spend on every
 * cold start. It also keeps the driver out of the module graph of tests that have no business
 * loading it, which matters more than it should: see the note in `vitest.config.ts`.
 */
async function createClient(uri: string): Promise<MongoClient> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, clientOptions);
  clientsCreated += 1;
  return client;
}

/**
 * The isolate's MongoDB client, constructing it on first use.
 *
 * @throws {DatabaseNotConfiguredError} when `MONGODB_URI` is absent or empty.
 */
export async function getMongoClient(env: unknown): Promise<MongoClient> {
  // Checked before the cached promise, so a misconfigured environment fails fast every time
  // rather than only on the request that happens to be first.
  const parsed = databaseEnvSchema.safeParse(env);
  if (!parsed.success) throw new DatabaseNotConfiguredError({ cause: parsed.error });

  // A *rejection* must not be cached. A malformed URI or a failed module load would otherwise
  // poison the isolate: every later request would replay the same stale failure, which is the
  // "was true recently" trap ADR-0013 rejects, only inverted and permanent.
  clientPromise ??= createClient(parsed.data.MONGODB_URI).catch((err: unknown) => {
    clientPromise = undefined;
    throw err;
  });
  return clientPromise;
}

/**
 * Round-trip the database to prove it is reachable *now*.
 *
 * The database is the one named in the connection string — the URI is the single source of
 * which database an environment talks to (workspace Rule 4), so nothing here picks a name.
 *
 * @throws {DatabaseNotConfiguredError} when `MONGODB_URI` is absent or empty.
 */
export async function pingDatabase(env: unknown): Promise<void> {
  const client = await getMongoClient(env);
  await client.db().command({ ping: 1 });
}
