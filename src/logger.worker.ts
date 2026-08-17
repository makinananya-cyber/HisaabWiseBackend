import type { AppLogger, LogLevel } from './logging';
import { LOG_LEVELS } from './logging';

import type { Config } from './config';

/**
 * The Workers implementation of `AppLogger`: one JSON object per line, written with `console.log`.
 *
 * pino cannot be used here — it reaches for `worker_threads` and Node stream internals that workerd
 * does not provide — so this reproduces the parts of its output the platform actually consumes:
 * a level, a timestamp, the bindings, and a message, as a single JSON line. Cloudflare's Workers
 * Logs and any Logpush destination parse that the same way they parse pino's output on Node.
 *
 * The redaction list is copied from `src/logger.ts` deliberately rather than shared. It is a
 * backstop against a mistake at a call site, and a backstop that lives next to the writer it
 * protects is one that cannot be disabled from somewhere else. The fields it covers are the ones
 * that must never reach a log: `MONGODB_URI` and anything derived from it (it carries a password),
 * raw passwords, raw security answers, and tokens.
 */
const REDACTED_KEYS = new Set([
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
  'authorization',
  'cookie',
]);

/**
 * Redaction walks the bindings rather than matching paths, because a Worker's log volume is small
 * and a missed nested field is worse than the traversal costs. Depth is bounded so a cyclic or
 * pathological object cannot turn a log line into an outage.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));

  // `Error` does not survive `JSON.stringify` — it serialises to `{}` — so it is unwrapped here.
  // Losing the message and stack of a caught error is the single most expensive logging bug there
  // is, because it turns a diagnosable failure into "unhandled error" with nothing attached.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(entry, depth + 1);
  }
  return out;
}

function createAt(level: LogLevel, ceiling: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(ceiling);
}

function build(
  level: LogLevel,
  ceiling: LogLevel,
  base: Record<string, unknown>,
): (bindings: object, message: string) => void {
  if (!createAt(level, ceiling)) return () => undefined;

  return (bindings: object, message: string): void => {
    const line = {
      level,
      time: Date.now(),
      ...base,
      ...(redact(bindings) as object),
      msg: message,
    };
    console.log(JSON.stringify(line));
  };
}

function loggerWith(ceiling: LogLevel, base: Record<string, unknown>): AppLogger {
  return {
    child: (bindings) => loggerWith(ceiling, { ...base, ...bindings }),
    fatal: build('fatal', ceiling, base),
    error: build('error', ceiling, base),
    warn: build('warn', ceiling, base),
    info: build('info', ceiling, base),
    debug: build('debug', ceiling, base),
    trace: build('trace', ceiling, base),
  };
}

/** The Workers counterpart of `createLogger`, with the same `env` binding on every line. */
export function createWorkerLogger(config: Config): AppLogger {
  // `silent` is in the config enum but not in LOG_LEVELS; it means "write nothing", which is what
  // an unmatched ceiling produces because no level compares below it.
  const ceiling = config.LOG_LEVEL === 'silent' ? undefined : config.LOG_LEVEL;

  if (!ceiling) {
    const silent = (): void => undefined;
    const noop: AppLogger = {
      child: () => noop,
      fatal: silent,
      error: silent,
      warn: silent,
      info: silent,
      debug: silent,
      trace: silent,
    };
    return noop;
  }

  return loggerWith(ceiling, { env: config.NODE_ENV });
}
