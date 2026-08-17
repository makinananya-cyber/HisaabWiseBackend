// Plain ESM rather than TypeScript so the lint config needs no extra loader and is not itself
// a typecheck target.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'worker-configuration.d.ts'],
  },
  {
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Invariant 1's second gate, per ADR-0002: "repositories are the only code touching
  // collections" is a lint failure rather than a code-review hope. The allowances below are the
  // whole point of the rule — an exception has to appear in a diff to be added.
  {
    files: ['src/**/*.ts'],
    ignores: [
      // Repositories are the sanctioned home for collection access.
      'src/repositories/**',
      // The `/health/db` deep check needs the *connection*, not a collection: it runs an admin
      // `ping` and reads no document, so there is nothing for a repository to own and nothing
      // for the read-side zod boundary to parse. Recorded here rather than smuggled in, and it
      // stays the only route-level exception — anything that reads or writes a document belongs
      // in `src/repositories/`. See ADR-0002 and ADR-0013.
      'src/routes/health.ts',
      // The entrypoint opens and closes the pool. It owns the connection lifecycle and touches no
      // collection.
      'src/server.ts',
      // The Cloudflare Workers entrypoint, for the same reason as `src/server.ts`. It connects
      // lazily rather than at boot because a Worker has no boot, but it owns the same lifecycle and
      // likewise touches no collection.
      'src/worker.ts',
      'src/db.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db', '**/db.js', 'mongodb'],
              message:
                'Only src/repositories/ may touch the database. See ADR-0002 (invariant 1). If you genuinely need raw access, put it in a repository or amend this rule so the exception is visible.',
            },
          ],
        },
      ],
    },
  },
);
