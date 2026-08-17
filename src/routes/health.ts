import { Hono } from 'hono';

import { pingDatabase } from '../db';
import type { AppEnv } from '../types/hono';

/**
 * Operational health endpoints. Two of them, on purpose — see ADR-0013.
 *
 * `GET /health` is shallow and does **no** database work. This is what the uptime monitor and the
 * platform health check hit at minute granularity; a database round trip here would spend a
 * connection per check.
 *
 * `GET /health/db` is the deep check that genuinely pings the database. Its whole purpose is to be
 * truthful right now, which is why it is never cached and why the result is not memoised —
 * `db:true` must mean "is true", not "was true recently".
 *
 * There is no `DB_NOT_CONFIGURED` case any more, and its absence is the point: `MONGODB_URI` is
 * validated in `src/config.ts` before the server binds a port, so a process that is answering
 * requests at all has a configured database. Failing to boot beats failing per request.
 */
export const healthRoutes = new Hono<AppEnv>()
  .get('/health', (c) => c.json({ status: 'ok' } as const))
  .get('/health/db', async (c) => {
    // A truthful answer cannot be served from a cache, at the edge or anywhere else.
    c.header('Cache-Control', 'no-store');

    try {
      await pingDatabase();
      return c.json({ status: 'ok', db: true } as const);
    } catch (err) {
      // Logged for the operator and deliberately not returned: a driver error can name cluster
      // hosts, and this endpoint is reachable without authentication.
      c.var.log.error(
        { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
        'health/db check failed',
      );

      return c.json(
        { error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable' } },
        503,
      );
    }
  });
