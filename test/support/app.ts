import { nodeArgon2 } from '../../src/auth/argon2Native';
import { setArgon2Backend } from '../../src/auth/hashing';
import { createApp } from '../../src/index';
import { loadConfig, type Config } from '../../src/config';
import { loadContent } from '../../src/content';
import { createLogger } from '../../src/logger';

/**
 * A configuration valid enough to build an app around, without reading the developer's `.env`.
 *
 * Tests must behave identically on a machine that has local secrets and one that does not, so the
 * environment is supplied explicitly rather than inherited.
 */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/hisaabwise_test_placeholder',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/**
 * An app wired the way production wires it, for driving through the HTTP seam.
 *
 * Content is loaded here for the same reason `src/server.ts` loads it before binding a port: the
 * content routes read from memory and reaching them unloaded is a programming error, not a 500 to
 * be exercised. `loadContent` is idempotent, so every test file paying for it once is free.
 */
export function testApp(config: Config = testConfig()) {
  loadContent();
  // The HTTP entrypoints install an argon2 backend before serving (`src/server.ts`, `src/worker.ts`);
  // the test harness has to as well, or every registration- or sign-in-driven suite 500s on the first
  // hash. Node's native backend, exactly as `server.ts` uses.
  setArgon2Backend(nodeArgon2);
  return createApp(config, createLogger(config));
}
