// Imported as types rather than pulled in globally through `tsconfig`'s `types` array: the Workers
// global definitions overlap Node's (`crypto`, `fetch`, `Request`) and letting them merge across
// the whole program would change what `src/server.ts` typechecks against.
import type {
  DurableObjectNamespace,
  DurableObjectState,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import type { Hono } from 'hono';

import { workersArgon2 } from './auth/argon2Workers';
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
 * Both build the same Hono app from `createApp`, so every route, the middleware chain and the error
 * envelope are shared. What differs is *where the app runs* — and on Workers that is not the request
 * isolate.
 *
 * **Why a Durable Object, not the request isolate (invariant 9).** The native MongoDB driver holds a
 * live TCP socket to Atlas, and Workers forbid using an I/O object created by one request from a
 * different request: the socket opened on the first request is unusable on the second, so every
 * database call after the first failed (in production a 500, in `wrangler dev` a hung request). A
 * request isolate is the wrong home for a persistent connection. A Durable Object is the right one —
 * a single long-lived actor with one stable context — which is exactly the escalation invariant 9
 * named. So the fetch handler here is a thin forwarder: it hands every request to one singleton
 * `AppBroker` instance, and the app, its Atlas connection and the module-scoped memoisation all live
 * inside that actor, where the connection is opened once and reused for the life of the object.
 *
 * **The tradeoff, stated plainly.** One singleton actor serialises the service's database traffic
 * through a single instance. That is deliberate for launch — it is what makes the connection reusable
 * at all — and it is the point at which to revisit sharding the broker (per-user, or a small pool of
 * named instances) if throughput ever demands it. `runMonthRollover` already keeps its per-user
 * structure, so that change stays a dispatch layer rather than a rewrite.
 *
 * **Where the ordering differs from Node, and why.** `src/server.ts` can validate configuration,
 * load content, connect to Atlas and build indexes *before* binding a port, so a broken deployment
 * never accepts traffic. The actor has no such moment — there is no boot, only a first request into
 * a cold instance. So the same sequence runs lazily on that first request and is memoised in module
 * scope, which persists for the life of the actor. A misconfigured Worker therefore fails on its
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

  // A Worker cannot load the native argon2 addon or pdfkit, so it installs the pure-JS argon2id and
  // a renderer that answers 501 rather than failing obscurely inside a library.
  setArgon2Backend(workersArgon2);
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

/** Kept in step with `wrangler.toml`'s `[triggers] crons`. */
const DAILY_PURGE_CRON = '0 3 * * *';

/**
 * The singleton actor that actually runs the service.
 *
 * Everything stateful lives here: the memoised `Ready` app, and — the reason this class exists — the
 * MongoDB connection, opened lazily on the first database request and reused across every request
 * after it, because a Durable Object is the one place on Workers where a socket outlives the request
 * that created it (see the file header).
 *
 * `ctx` and `env` are handed to the constructor by the runtime (the classic Durable Object shape);
 * `ctx.waitUntil` lets a scheduled job finish writing after the trigger that fired it returns.
 */
export class AppBroker {
  private readonly ctx: DurableObjectState;
  private readonly env: EnvSource;

  constructor(ctx: DurableObjectState, env: EnvSource) {
    this.ctx = ctx;
    this.env = env;
  }

  /**
   * Serves a forwarded request — or, on the internal cron path the entrypoint refuses to forward
   * from outside, runs the scheduled job named in the query string and answers `202`.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === CRON_PATH) {
      await this.runScheduled(url.searchParams.get('cron') ?? '');
      return new Response(null, { status: 202 });
    }

    const state = bootApp(this.env);
    if (!NO_DATABASE.has(url.pathname)) {
      await bootDatabase(state);
    }

    // The app does not use `waitUntil` for correctness (no route defers work past its response), but
    // Hono expects an execution context, so this bridges to the actor's own.
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        this.ctx.waitUntil(promise);
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    return state.app.fetch(request, this.env, executionCtx);
  }

  /**
   * The cron work, reachable only through `CRON_PATH`, which the entrypoint constructs itself and
   * never forwards from an outside request — so nobody can trigger a job by guessing a URL.
   *
   * `src/scheduler.ts` chains `setTimeout` on a long-lived Node process; an actor is not torn down
   * between requests but the platform's Cron Triggers are still what fire it. The cron expressions in
   * `wrangler.toml` mirror the intervals the scheduler used: every 15 minutes for the rollover
   * (Asia/Kolkata is +05:30 and Asia/Kathmandu +05:45, so hourly would be wrong), and daily for the
   * purge. Both jobs are safe to run concurrently — the unique `(userId, monthKey)` index makes a
   * doubled rollover race to the same result.
   *
   * **The limit worth knowing:** a scheduled invocation gets up to 30 s of CPU on the paid plan.
   * That is ample for the purge and for a rollover over a modest user table, but `month:rollover`
   * walks every due user, so at scale this needs the cron → Queues fan-out that ADR-0007 specified.
   */
  private async runScheduled(cron: string): Promise<void> {
    const state = bootApp(this.env);
    const { logger } = state;
    await bootDatabase(state);

    const job =
      cron === DAILY_PURGE_CRON
        ? { name: 'purge:deleted', run: runPurgeDeleted }
        : { name: 'month:rollover', run: runMonthRollover };

    await job.run(logger.child({ job: job.name })).catch((err: unknown) => {
      logger.error({ err, job: job.name }, 'scheduled job failed');
    });
  }
}

/**
 * The internal path the cron trigger posts to. It lives under `INTERNAL_PREFIX`, which the
 * entrypoint returns `404` for on any request from outside — so this actor method is reachable only
 * by the `scheduled` handler below, never by a client guessing a URL.
 */
const INTERNAL_PREFIX = '/__do/';
const CRON_PATH = `${INTERNAL_PREFIX}cron`;

interface WorkerEnv {
  readonly APP_BROKER: DurableObjectNamespace;
}

/**
 * The actor's `fetch`, typed for the entrypoint. Cast onto the stub because a `DurableObjectStub`'s
 * method surface is not carried through the binding's types in this toolchain — the runtime routes
 * the call regardless.
 */
interface BrokerStub {
  fetch(request: Request): Promise<Response>;
}

/** The one instance. A fixed name means every request reaches the same actor and the same pool. */
function broker(env: WorkerEnv): BrokerStub {
  const namespace = env.APP_BROKER;
  return namespace.get(namespace.idFromName('singleton')) as unknown as BrokerStub;
}

/**
 * The Worker itself: a thin forwarder into the singleton actor, holding no state and touching no
 * database, so nothing here can outlive a request in a way the platform forbids.
 */
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // The actor's internal paths are not part of the public surface; refuse them from outside rather
    // than forwarding, so `CRON_PATH` cannot be reached by a client.
    if (new URL(request.url).pathname.startsWith(INTERNAL_PREFIX)) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return broker(env).fetch(request);
  },

  scheduled(event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    // The entrypoint constructs the internal cron request itself; `waitUntil` keeps the trigger alive
    // until the actor has finished running the job.
    const cronRequest = new Request(
      `https://broker.internal${CRON_PATH}?cron=${encodeURIComponent(event.cron)}`,
    );
    ctx.waitUntil(broker(env).fetch(cronRequest));
  },
};
