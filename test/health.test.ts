import { describe, expect, it } from 'vitest';

import { testApp } from './support/app';

// Driven through `app.request()` — the real fetch handler with its real middleware chain — rather
// than by calling a route function directly, so routing, method handling, the security headers and
// the serialised body are all covered. This is the HTTP seam on Node; it was
// `exports.default.fetch` on Workers, and it carries the same tests.
const app = testApp();

describe('GET /health', () => {
  it('returns 200 with {status:"ok"}', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('responds as JSON', async () => {
    const response = await app.request('/health');

    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('rejects a non-GET method', async () => {
    const response = await app.request('/health', { method: 'POST' });

    expect(response.status).toBe(404);
  });

  it('carries a request id, so one line in the logs can be found from a response', async () => {
    const response = await app.request('/health');

    expect(response.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
  });

  it('echoes an upstream request id rather than minting its own', async () => {
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'upstream-correlation-id' },
    });

    expect(response.headers.get('x-request-id')).toBe('upstream-correlation-id');
  });
});

describe('unknown routes', () => {
  it('return 404 with the error envelope', async () => {
    const response = await app.request('/nope');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
