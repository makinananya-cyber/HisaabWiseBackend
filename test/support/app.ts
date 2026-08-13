import { createApp } from '../../src/index';
import { loadConfig, type Config } from '../../src/config';
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

/** An app wired the way production wires it, for driving through the HTTP seam. */
export function testApp(config: Config = testConfig()) {
  return createApp(config, createLogger(config));
}
