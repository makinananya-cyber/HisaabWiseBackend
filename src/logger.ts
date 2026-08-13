import { pino, type Logger } from 'pino';

import type { Config } from './config';

/**
 * Structured JSON to stdout, one line per event. No pretty-printer in production: the host
 * collects stdout, and a human-formatted line is harder to query than a JSON one.
 *
 * Fields that must never be logged: `MONGODB_URI` and anything derived from it (it carries a
 * password), raw security answers, raw passwords, access or refresh tokens. `redact` below is a
 * backstop, not a licence to pass them in.
 */
export function createLogger(config: Config): Logger {
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
