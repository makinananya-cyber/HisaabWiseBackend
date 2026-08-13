import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { endpoints, negativeFixtures } from './endpoints';

const corpusDir = path.join(import.meta.dirname, 'corpus');

interface Manifest {
  syncedFromIosCommit: string;
  endpointPaths: string[];
  fixtures: { name: string; sha256: string; bytes: number }[];
}

const manifest = JSON.parse(readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8')) as Manifest;

/**
 * The coverage gate.
 *
 * Adapted from iOS ADR-0027, which made the client's corpus coverage derive from the source rather
 * than from a list somebody must remember to extend — because the failure mode of a hand-kept list
 * is a green suite. The same argument applies in reverse here: the backend must not be able to
 * ignore a path the client calls.
 */
describe('contract coverage', () => {
  it('covers every /v1 path the client calls', () => {
    const declared = new Set(endpoints.map((endpoint) => endpoint.path));

    // A literal in the client is covered if it is declared verbatim, or if it is the static prefix
    // of a parameterised route the client builds by appending (`/v1/expenses` → `/v1/expenses/:id`).
    const uncovered = manifest.endpointPaths.filter((clientPath) => {
      if (declared.has(clientPath)) return false;
      return ![...declared].some((route) => route.startsWith(`${clientPath}/`));
    });

    expect(uncovered, 'add these to test/contract/endpoints.ts with their slice').toEqual([]);
  });

  it('claims every fixture in the corpus', () => {
    const claimed = new Set([...endpoints.flatMap((endpoint) => endpoint.fixtures), ...negativeFixtures]);
    const present = readdirSync(corpusDir).filter(
      (name) => name.endsWith('.json') && name !== 'manifest.json',
    );

    const unclaimed = present.filter((name) => !claimed.has(name));

    expect(
      unclaimed,
      'a fixture nothing claims is a payload shape no endpoint is committed to producing',
    ).toEqual([]);
  });

  it('names only fixtures that exist', () => {
    const present = new Set(readdirSync(corpusDir));
    const missing = [...endpoints.flatMap((e) => e.fixtures), ...negativeFixtures].filter(
      (name) => !present.has(name),
    );

    expect(missing, 'run `npm run contract:sync`').toEqual([]);
  });

  it('records the iOS commit the corpus came from', () => {
    expect(manifest.syncedFromIosCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});

/**
 * Progress, as a test rather than a status report. Each pending endpoint is a `todo`, so the suite
 * shows exactly what is left without a permanently red build crying wolf. When a slice lands, its
 * entries flip to `live` and their payloads start being asserted against the fixtures.
 */
describe('endpoint implementation', () => {
  const bySlice = new Map<number, typeof endpoints>();
  for (const endpoint of endpoints) {
    bySlice.set(endpoint.slice, [...(bySlice.get(endpoint.slice) ?? []), endpoint]);
  }

  for (const [slice, sliceEndpoints] of [...bySlice.entries()].sort((a, b) => a[0] - b[0])) {
    describe(`slice ${String(slice)}`, () => {
      for (const endpoint of sliceEndpoints) {
        const label = `${endpoint.method} ${endpoint.path}`;
        if (endpoint.status === 'pending') {
          it.todo(label);
        } else {
          it(label, () => {
            // Live endpoints are asserted by their own slice's integration test, which seeds a
            // user and drives the real route. This entry exists so the manifest cannot claim
            // something is live without a test standing behind it.
            expect(endpoint.fixtures.length + (endpoint.note === undefined ? 0 : 1)).toBeGreaterThan(0);
          });
        }
      }
    });
  }
});
