import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { connectionDiagnostics } from '../src/db';

// Driven through the real Worker fetch handler, same as `health.test.ts`.
const worker = exports.default;

// `MONGODB_URI` is pinned empty for the whole suite in `vitest.config.ts`, so what is covered
// here is the misconfiguration path and the absence of database work — deterministically, on
// every machine. The live assertion that `GET /health/db` returns `db:true` against Atlas is
// made against `wrangler dev`, for the reason recorded in that config; mocking the driver
// instead would have defeated the entire purpose of the spike.
describe('GET /health/db without a configured database', () => {
  it('fails fast with 503 and a greppable code', async () => {
    const response = await worker.fetch('https://hisaabwise.test/health/db');
    const body = await response.json<{ error: { code: string; message: string } }>();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('DB_NOT_CONFIGURED');
    // The message has to name the thing to fix, not merely report that something is wrong.
    expect(body.error.message).toContain('MONGODB_URI');
  });

  it('is never cached — the endpoint exists to be truthful right now', async () => {
    const response = await worker.fetch('https://hisaabwise.test/health/db');

    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('does not construct a client it cannot configure', async () => {
    await worker.fetch('https://hisaabwise.test/health/db');

    expect(connectionDiagnostics().clientsCreated).toBe(0);
  });

  it('rejects a non-GET method', async () => {
    const response = await worker.fetch('https://hisaabwise.test/health/db', { method: 'POST' });

    expect(response.status).toBe(404);
  });
});

// Acceptance criterion: `/health` still performs no database access — verified, not assumed.
// The `health.test.ts` comment noted this could not be asserted while no database module
// existed. It can now: the module counts the clients this isolate has constructed, and a
// request that reached the database would have had to construct one.
//
// Written as a before/after delta rather than an absolute zero so it stays true regardless of
// what ran first. Paired with the status assertion it is not vacuous: no database is configured
// in this suite, so a `/health` that reached for one would either construct a client — failing
// the delta — or fail to configure it and answer 503, failing the status.
describe('GET /health', () => {
  it('performs no database access', async () => {
    const before = connectionDiagnostics().clientsCreated;

    for (let i = 0; i < 3; i++) {
      const response = await worker.fetch('https://hisaabwise.test/health');
      expect(response.status).toBe(200);
    }

    expect(connectionDiagnostics().clientsCreated).toBe(before);
  });
});

// Invariant 9 is a configuration fact rather than a behaviour observable over HTTP, and it is
// the one thing here that cannot be checked from the outside. Asserted against the module's
// reported settings so that raising the cap fails a test rather than silently multiplying the
// Atlas connections a burst of traffic can open.
describe('connection discipline', () => {
  it('caps the pool at one connection with a minimum of zero', () => {
    expect(connectionDiagnostics()).toMatchObject({ maxPoolSize: 1, minPoolSize: 0 });
  });
});
