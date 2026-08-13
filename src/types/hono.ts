import type { Logger } from 'pino';

import type { Config } from '../config';

/**
 * The Hono environment for this app.
 *
 * `Variables` replaces what `c.env` was on Workers. Configuration and the logger are injected by
 * middleware rather than reached for as module globals, so a test can build an app around a
 * different configuration without mutating `process.env`.
 */
export interface AppEnv {
  Variables: {
    config: Config;
    log: Logger;
  };
}
