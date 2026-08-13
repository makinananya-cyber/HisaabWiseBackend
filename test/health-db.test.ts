import { describe, expect, it } from 'vitest';

import { testApp } from './support/app';

// No database is connected in this suite, and that is what makes these assertions work.
//
// On Workers, "`/health` performs no database access" needed a client-creation counter to observe.
// On Node the proof is structural and much stronger: nothing has called `connectDatabase`, so any
// code path that reached for the database *cannot* succeed. `/health` answering 200 is therefore
// evidence that it never tried.
//
// The live round trip — `{status:"ok", db:true}` against Atlas — is verified by
// `npm run verify:db` against a running server, and by the integration suite once ADR-0014's
// per-run database harness lands.
const app = testApp();

describe('GET /health/db without a connected database', () => {
  it('answers 503 with the error envelope rather than throwing', async () => {
    const response = await app.request('/health/db');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable' },
    });
  });

  it('is never cached — the endpoint exists to be truthful right now', async () => {
    const response = await app.request('/health/db');

    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('does not leak the driver error, which can name cluster hosts', async () => {
    const response = await app.request('/health/db');
    const body = await response.text();

    expect(body).not.toMatch(/mongodb|27017|hisaabwise_test|connectDatabase/i);
  });

  it('rejects a non-GET method', async () => {
    const response = await app.request('/health/db', { method: 'POST' });

    expect(response.status).toBe(404);
  });
});

describe('GET /health', () => {
  it('performs no database access — it answers while the database is unreachable', async () => {
    for (let i = 0; i < 3; i++) {
      const response = await app.request('/health');
      expect(response.status).toBe(200);
    }
  });
});
