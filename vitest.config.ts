import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd against the real Worker built from wrangler.toml, so a test that
// drives `exports.default.fetch` dispatches through a loopback service binding and exercises
// the same fetch handler production serves.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
});
