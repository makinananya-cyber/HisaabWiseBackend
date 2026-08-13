import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from 'pino';

import type { Config } from './config';
import { contentRoutes } from './routes/content';
import { healthRoutes } from './routes/health';
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

  // Every error response in this service uses one envelope: `{error: {code, message}}`.
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

  app.onError((err, c) => {
    c.var.log.error({ err, path: new URL(c.req.url).pathname }, 'unhandled error');
    return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
  });

  return app;
}
