import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd against the real Worker built from wrangler.toml, so a test that
// drives `exports.default.fetch` dispatches through a loopback service binding and exercises
// the same fetch handler production serves.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // `MONGODB_URI` is pinned empty so the suite behaves identically on a machine that has
        // a `.dev.vars` and one that does not — otherwise these tests would pass or fail
        // depending on a gitignored file.
        //
        // It has to be pinned *empty* rather than pointed at a database, because
        // `@cloudflare/vitest-pool-workers` (0.20.3) cannot load the `mongodb` driver at all.
        // The pool serves dependencies to workerd one file at a time instead of bundling them,
        // and workerd names modules by resolved path: the driver's `lib/bson.js` requires the
        // separate `bson` package, workerd resolves that bare specifier against the requiring
        // module's own directory — `mongodb/lib/bson`, already in its registry — and the
        // module imports itself until the re-export getters overflow the stack. Because both
        // specifiers collide on one registry name, workerd never asks the pool a second time,
        // and the pool resolves file paths before consulting Vite, so no plugin, alias or
        // `deps.optimizer` setting can intervene.
        //
        // This is a harness limitation, not a platform one: `wrangler dev` and
        // `wrangler deploy` bundle with esbuild and load the driver without complaint. What
        // follows from it:
        //
        //  - `src/db.ts` imports the driver dynamically, so nothing that does not talk to the
        //    database drags it into the module graph.
        //  - The live database assertions — `GET /health/db` returning `db:true` against
        //    Atlas — run against `wrangler dev` instead. See the README.
        //  - The integration tests ADR-0014 describes (per-run test databases, the rollover
        //    suite) need this resolved first. It is a prerequisite of the repository ticket,
        //    not of this one.
        bindings: { MONGODB_URI: '' },
      },
    }),
  ],
});
