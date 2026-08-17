/**
 * Loads `.env` before any suite runs, so integration tests find `MONGODB_URI`.
 *
 * `npm run dev` gets this from `tsx --env-file-if-exists`; vitest has no equivalent flag, and without it
 * the integration suites would skip on the machine where the credentials actually are — which is the
 * worst outcome, because a skipped test reads as a passing one.
 *
 * **It does not overwrite what is already set.** A CI runner supplies these as real environment
 * variables, and a stale committed `.env` must never win over them. `process.loadEnvFile` follows that
 * rule already; the try/catch is for the ordinary case of there being no `.env` at all.
 *
 * Note what this does *not* do: it does not make `.env`'s database the one tests use.
 * `test/support/database.ts` derives a per-run `hisaabwise_test_*` name from the URI's host and refuses
 * anything that does not carry `_test_` (ADR-0014).
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No `.env`, which is the normal case in CI. Integration suites skip if nothing supplied the URI.
}
