import { pino } from 'pino';

import type { Config } from './config';
import type { AppLogger } from './logging';

/**
 * Structured JSON to stdout, one line per event. No pretty-printer in production: the host
 * collects stdout, and a human-formatted line is harder to query than a JSON one.
 *
 * Fields that must never be logged: `MONGODB_URI` and anything derived from it (it carries a
 * password), raw security answers, raw passwords, access or refresh tokens. `redact` below is a
 * backstop, not a licence to pass them in.
 *
 * The return type is `AppLogger`, the interface in `src/logging.ts`, not pino's own `Logger`. A
 * pino logger satisfies it structurally, so nothing about this function's behaviour changes; what
 * it buys is that no route, job or middleware imports pino, and the same code runs under workerd
 * where pino cannot be loaded at all.
 */
export function createLogger(config: Config): AppLogger {
  return pino({
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV },
    redact: {
      paths: [
        'password',
        'newPassword',
        'currentPassword',
        'answers',
        'answer',
        'token',
        'refreshToken',
        'accessToken',
        'uri',
        'MONGODB_URI',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
  });
}
