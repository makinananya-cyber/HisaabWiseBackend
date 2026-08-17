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
    //
    // **90 s rather than 30.** A live end-to-end session measured this cluster at a ~1 s median but an
    // ~11 s p90 and a 21.7 s worst case for a single request, and a rollover test makes a dozen in a row.
    // At 30 s the suite failed on a *different* test on each run while the other fifteen passed — a
    // latency flake, not a defect, and the most expensive kind of red there is: the rollover suite is a
    // release gate, so a gate that fails at random is a gate people learn to re-run rather than read.
    //
    // This raises the ceiling on a slow network; it does not make a hanging test pass. If these start
    // taking minutes rather than seconds, the latency itself is the bug to chase (report O3), not this
    // number.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Domain tests are pure and fast; database tests must not interleave against one another's
    // collections. Files run in parallel, tests within a file in sequence.
    sequence: { concurrent: false },
  },
});
