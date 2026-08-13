import { defineConfig } from 'vitest/config';

// Plain Node. The Workers pool is gone with the runtime, and with it the module-resolution defect
// that stopped it loading the `mongodb` driver at all — which is what blocked ADR-0014's per-run
// integration databases.
//
// The HTTP seam is `app.request()` on an app built by `createApp`: real routing, real middleware,
// real serialised responses, no socket. Integration tests that need a database create and drop
// `hisaabwise_test_<runId>` per ADR-0014.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Loads `.env` so the integration suites find `MONGODB_URI` on a developer's machine. Without it
    // they would skip exactly where the credentials are, and a skipped test reads as a passing one.
    setupFiles: ['test/support/env.ts'],
    // Integration suites connect to Atlas: a cold `mongodb+srv://` connect from the UAE measures ~3 s
    // across three TLS handshakes, and argon2 hashing adds to the per-test cost.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Domain tests are pure and fast; database tests must not interleave against one another's
    // collections. Files run in parallel, tests within a file in sequence.
    sequence: { concurrent: false },
  },
});
