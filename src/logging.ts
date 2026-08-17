/**
 * The logging surface the application actually uses, named as a type of its own.
 *
 * Every call site in this codebase logs the same shape — a bindings object, then a message — so
 * that is all this interface promises. It exists because `pino`'s `Logger` cannot be imported into
 * a Cloudflare Worker: pino reaches for worker threads and Node stream internals that workerd does
 * not provide. Depending on the interface rather than on pino keeps the routes, the jobs and the
 * middleware identical on both runtimes.
 *
 * A real pino `Logger` satisfies this structurally, so `src/logger.ts` returns one unchanged and
 * Node behaviour is exactly what it was. `src/logger.worker.ts` provides the other implementation.
 */
export interface AppLogger {
  /** A logger carrying additional bindings — a request id, a job name — on every line it writes. */
  child(bindings: Record<string, unknown>): AppLogger;
  fatal(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  info(bindings: object, message: string): void;
  debug(bindings: object, message: string): void;
  trace(bindings: object, message: string): void;
}

/** The levels, most severe first, so a configured level can be compared by index. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
