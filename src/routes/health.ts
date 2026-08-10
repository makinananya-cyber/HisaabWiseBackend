import { Hono } from 'hono';

import { DatabaseNotConfiguredError, pingDatabase } from '../db';

/**
 * Operational health endpoints. Two of them, on purpose — see ADR-0013.
 *
 * `GET /health` is shallow and does **no** database work. This is what the uptime monitor and
 * the Cloudflare health check hit at minute granularity. On Workers each ping can land in a
 * fresh isolate, so a database round trip here would open an Atlas connection per check —
 * spending exactly the resource that connection discipline exists to conserve (invariant 9).
 *
 * `GET /health/db` is the deep check that genuinely pings the database. Used by the Phase 0
 * exit gate and post-deploy verification, not by a minute-granularity monitor. Its whole
 * purpose is to be truthful right now, which is why it is never cached and why the result is
 * not memoised — `db:true` must mean "is true", not "was true recently".
 */
export const healthRoutes = new Hono<{ Bindings: Env }>()
  .get('/health', (c) => c.json({ status: 'ok' } as const))
  .get('/health/db', async (c) => {
    // A truthful answer cannot be served from a cache, at the edge or anywhere else.
    c.header('Cache-Control', 'no-store');

    try {
      await pingDatabase(c.env);
      return c.json({ status: 'ok', db: true } as const);
    } catch (err) {
      const configuration = err instanceof DatabaseNotConfiguredError;

      // Structured JSON to Workers Logs. The failure detail is logged for the operator and
      // deliberately not returned: a driver error can name cluster hosts, and this endpoint is
      // reachable without authentication.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'health/db check failed',
          reason: configuration ? 'not_configured' : 'unreachable',
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }),
      );

      return c.json(
        configuration
          ? { error: { code: 'DB_NOT_CONFIGURED', message: 'MONGODB_URI is not configured' } }
          : { error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable' } },
        503,
      );
    }
  });
