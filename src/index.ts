import { Hono } from 'hono';

import { healthRoutes } from './routes/health';

// `Env` is global, generated from wrangler.toml by `wrangler types`.
const app = new Hono<{ Bindings: Env }>();

// Operational endpoints sit outside `/v1` — they are infrastructure, not part of the client
// API contract. The versioned routes are mounted by the contract ticket.
app.route('/', healthRoutes);

// Every error response in this service uses one envelope: `{error: {code, message}}`.
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

app.onError((err, c) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: err.message,
      path: new URL(c.req.url).pathname,
    }),
  );
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
});

export default app;
