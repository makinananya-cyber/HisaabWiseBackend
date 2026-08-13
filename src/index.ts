import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from 'pino';

import type { Config } from './config';
import { ApiError, errorBody } from './errors';
import { authRoutes } from './routes/auth';
import { contentRoutes } from './routes/content';
import { expenseRoutes } from './routes/expenses';
import { healthRoutes } from './routes/health';
import { learnRoutes } from './routes/learn';
import { meRoutes } from './routes/me';
import { reportRoutes } from './routes/reports';
import { screenRoutes } from './routes/screens';
import type { AppEnv } from './types/hono';

/**
 * Builds the application.
 *
 * A factory rather than a module-scope singleton so tests construct an app around an explicit
 * configuration. The same function serves production — `src/server.ts` calls it once.
 */
export function createApp(config: Config, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Configuration and a request-scoped logger, in place of Workers' `c.env`.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    c.set('config', config);
    c.set('log', logger.child({ requestId }));
    c.header('X-Request-Id', requestId);
    await next();
  });

  app.use('*', secureHeaders());

  // The iOS client needs no CORS; this is for the marketing site only, so an empty
  // `CORS_ORIGINS` correctly allows nothing rather than everything.
  const origins = config.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length > 0) app.use('/v1/*', cors({ origin: origins }));

  // One line per request, after it completes, with the status and duration.
  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    c.var.log.info(
      {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        ms: Math.round(performance.now() - startedAt),
      },
      'request',
    );
  });

  // Operational endpoints sit outside `/v1` — they are infrastructure, not part of the client API
  // contract. The versioned routes are mounted by the slices that implement them.
  app.route('/', healthRoutes);
  app.route('/', contentRoutes);
  app.route('/', authRoutes);
  app.route('/', meRoutes);
  app.route('/', screenRoutes);
  app.route('/', expenseRoutes);
  app.route('/', learnRoutes);
  app.route('/', reportRoutes);

  // Every error response in this service uses one envelope: `{error: {code, message}}`.
  app.notFound((c) => c.json(errorBody('NOT_FOUND'), 404));

  /**
   * Two kinds of failure, and the distinction is the point.
   *
   * An `ApiError` is a **decision** a route made — a wrong password, a closed month, a taken email — so
   * it carries its own code and status and is logged at `info`. Anything else reaching here is a **bug**,
   * so it is logged at `error` with the stack and answered `500` with nothing about it in the body.
   *
   * `ApiError.detail` never reaches the response. It is where the zod paths and the offending field names
   * go, and those describe internal structure.
   */
  app.onError((err, c) => {
    const path = new URL(c.req.url).pathname;

    if (err instanceof ApiError) {
      c.var.log.info({ code: err.code, detail: err.detail, path }, 'request refused');
      return c.json(err.body, err.status);
    }

    c.var.log.error({ err, path }, 'unhandled error');
    return c.json(errorBody('INTERNAL'), 500);
  });

  return app;
}
