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
    // Domain tests are pure and fast; database tests must not interleave against one another's
    // collections. Files run in parallel, tests within a file in sequence.
    sequence: { concurrent: false },
  },
});
