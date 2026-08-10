import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// Driven through `exports.default.fetch` — the real Worker fetch handler built from
// wrangler.toml — rather than by calling the Hono app directly, so routing, method handling
// and the serialised response body are all covered.
const worker = exports.default;

// These tests cover the response contract. The *absence* of database access on this path is
// asserted in `health-db.test.ts`, which can observe how many clients the isolate has
// constructed; the enforcement mechanism is the `no-restricted-imports` rule in
// `eslint.config.mjs` confining database imports (invariant 1, ADR-0002).
describe('GET /health', () => {
  it('returns 200 with {status:"ok"}', async () => {
    const response = await worker.fetch('https://hisaabwise.test/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('responds as JSON', async () => {
    const response = await worker.fetch('https://hisaabwise.test/health');

    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('rejects a non-GET method', async () => {
    const response = await worker.fetch('https://hisaabwise.test/health', { method: 'POST' });

    expect(response.status).toBe(404);
  });
});

describe('unknown routes', () => {
  it('return 404 with the error envelope', async () => {
    const response = await worker.fetch('https://hisaabwise.test/nope');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
