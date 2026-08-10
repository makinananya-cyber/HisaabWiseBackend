import { Hono } from 'hono';

/**
 * Shallow liveness check. Does **no** database work.
 *
 * This is what the uptime monitor and the Cloudflare health check hit at minute granularity.
 * On Workers each ping can land in a fresh isolate, so a database round trip here would open
 * an Atlas connection per check — spending exactly the resource that connection discipline
 * exists to conserve. The deep check that genuinely pings the database is a separate
 * endpoint, `GET /health/db`.
 *
 * See ADR-0013 and workspace invariant 9.
 */
export const healthRoutes = new Hono<{ Bindings: Env }>().get('/health', (c) =>
  c.json({ status: 'ok' } as const),
);
