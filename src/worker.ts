// Imported as types rather than pulled in globally through `tsconfig`'s `types` array: the Workers
// global definitions overlap Node's (`crypto`, `fetch`, `Request`) and letting them merge across
// the whole program would change what `src/server.ts` typechecks against.
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { Hono } from 'hono';

import { wasmArgon2 } from './auth/argon2Wasm';
import { setArgon2Backend } from './auth/hashing';
import { loadConfig, type Config, type EnvSource } from './config';
import { loadContent, setContentSource } from './content';
import { bundledContentSource } from './content.bundled';
import { setPdfRenderer, unavailableRenderer } from './content/pdfRenderer';
import { connectDatabase } from './db';
import { createApp } from './index';
import { createWorkerLogger } from './logger.worker';
import type { AppLogger } from './logging';
import { ensureIndexes } from './repositories/indexes';
import { runMonthRollover } from './jobs/monthRollover';
import { runPurgeDeleted } from './jobs/purgeDeleted';
import type { AppEnv } from './types/hono';

/**
 * The Cloudflare Workers entrypoint, the counterpart of `src/server.ts`.
 *
 * The two differ only in what they set up, never in what they serve: both build the same Hono app
 * from `createApp`, so every route, the middleware chain and the error envelope are shared.
 *
 * **Where the ordering differs from Node, and why.** `src/server.ts` can validate configuration,
 * load content, connect to Atlas and build indexes *before* binding a port, so a broken deployment
 * never accepts traffic. A Worker has no such moment — there is no boot, only a first request into
 * a cold isolate. So the same sequence runs lazily on that first request and is memoised in module
 * scope, which persists for the life of the isolate. A misconfigured Worker therefore fails on its
 * first request rather than at deploy time; that is a real loss against Node's fail-fast, inherent
 * to the platform rather than to this code.
 */

interface Ready {
  readonly app: Hono<AppEnv>;
  readonly config: Config;
  readonly logger: AppLogger;
}

let ready: Ready | undefined;
let database: Promise<unknown> | undefined;

/**
 * Everything that does not touch the network: configuration, content, and the runtime's
 * implementations of the three things that differ from Node.
 *
 * Synchronous and cheap, so it can run on every request and cost nothing after the first.
 */
function bootApp(env: EnvSource): Ready {
  if (ready) return ready;

  const config = loadConfig(env);
  const logger = createWorkerLogger(config);

  // A Worker cannot load the native argon2 addon or pdfkit, so it installs the WebAssembly hash and
  // a renderer that answers 501 rather than failing obscurely inside a library.
  setArgon2Backend(wasmArgon2);
  setPdfRenderer(unavailableRenderer);
  setContentSource(bundledContentSource);
  loadContent();

  ready = { app: createApp(config, logger), config, logger };
  return ready;
}

/**
 * The Atlas connection and the index build, kept **out** of the request path until something
 * actually needs the database.
 *
 * This is ADR-0013 carried onto a platform where it matters more, not less. That ADR keeps
 * `/health` free of database work so an orchestrator polling every few seconds does not spend an
 * Atlas connection per probe. On Node that is one long-lived process; on Workers each cold isolate
 * would otherwise open its own connection *on a health check*, and isolates are numerous and
 * short-lived. Connecting eagerly here would turn the cheapest endpoint in the service into the
 * most expensive one against invariant 9's ceiling.
 *
 * Memoised per isolate. A rejection is deliberately not cached: one transient Atlas failure must
 * not poison the isolate for its whole life.
 */
function bootDatabase({ config, logger }: Ready): Promise<unknown> {
  database ??= connectDatabase(config, {
    onRetry: ({ attempt, attempts, delayMs, err }) => {
      logger.warn(
        {
          attempt,
          attempts,
          retryInMs: delayMs,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        'database connection failed, retrying',
      );
    },
  })
    // Same reasoning as on Node: the unique `(userId, monthKey)` index is what makes the rollover
    // safe to retry, and the unique `email` is what refuses a duplicate registration. Idempotent,
    // so paying for it once per isolate is cheap — Atlas answers an already-satisfied build fast.
    .then(() => ensureIndexes(logger))
    .catch((err: unknown) => {
      database = undefined;
      throw err;
    });

  return database;
}

/**
 * The one route that must answer without a database, by design (ADR-0013). `/health/db` is
 * deliberately *not* in this set — its whole purpose is to report on the connection.
 */
const NO_DATABASE = new Set(['/health']);

export default {
  async fetch(request: Request, env: EnvSource, ctx: ExecutionContext): Promise<Response> {
    const state = bootApp(env);

    if (!NO_DATABASE.has(new URL(request.url).pathname)) {
      await bootDatabase(state);
    }

    return state.app.fetch(request, env, ctx);
  },

  /**
   * The cron handler, replacing the in-process scheduler.
   *
   * `src/scheduler.ts` chains `setTimeout` on a long-lived Node process; a Worker isolate is torn
   * down between requests, so the platform's Cron Triggers take over. The cron expressions in
   * `wrangler.toml` mirror the intervals the scheduler used: every 15 minutes for the rollover
   * (Asia/Kolkata is +05:30 and Asia/Kathmandu +05:45, so hourly would be wrong), and daily for the
   * purge.
   *
   * Both jobs are already safe to run concurrently — the unique `(userId, monthKey)` index makes a
   * doubled rollover race to the same result — which is what allows this to invoke them directly.
   *
   * **The limit worth knowing:** a scheduled handler gets up to 30 s of CPU on the paid plan. That
   * is ample for the purge and for a rollover over a modest user table, but `month:rollover` walks
   * every due user, so at scale this needs the cron → Queues fan-out that ADR-0007 originally
   * specified. `runMonthRollover` keeps its per-user structure, so that change is a dispatch layer
   * rather than a rewrite of the job.
   */
  async scheduled(event: ScheduledController, env: EnvSource, ctx: ExecutionContext): Promise<void> {
    const state = bootApp(env);
    const { logger } = state;
    // Unlike a request, a job is nothing but database work, so this always waits for the connection.
    await bootDatabase(state);

    const job =
      event.cron === DAILY_PURGE_CRON
        ? { name: 'purge:deleted', run: runPurgeDeleted }
        : { name: 'month:rollover', run: runMonthRollover };

    // `waitUntil` so the handler is not torn down while the job is still writing.
    ctx.waitUntil(
      job.run(logger.child({ job: job.name })).then(
        () => undefined,
        (err: unknown) => {
          logger.error({ err, job: job.name }, 'scheduled job failed');
        },
      ),
    );
  },
};

/** Kept in step with `wrangler.toml`'s `[triggers] crons`. */
const DAILY_PURGE_CRON = '0 3 * * *';
