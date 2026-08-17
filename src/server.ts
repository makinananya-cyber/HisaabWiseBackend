import { serve } from '@hono/node-server';

import { nodeArgon2 } from './auth/argon2Native';
import { setArgon2Backend } from './auth/hashing';
import { loadConfig } from './config';
import { loadContent } from './content';
import { renderCurriculumPdf } from './content/curriculumPdf';
import { setPdfRenderer } from './content/pdfRenderer';
import { closeDatabase, connectDatabase } from './db';
import { createApp } from './index';
import { createLogger } from './logger';
import { ensureIndexes } from './repositories/indexes';
import { startScheduler } from './scheduler';

/**
 * The entrypoint. Ordering here is the whole point:
 *
 *  1. Validate configuration — a bad environment fails before anything else happens.
 *  2. Load and validate the editorial content — a container image missing `content/`, or carrying a
 *     lossy extraction, fails at boot rather than serving a Learn tab with four units in it.
 *  3. Connect the database — an unreachable cluster fails before a port is bound, so the platform
 *     health check never goes green on a process that cannot serve.
 *  4. Only then accept traffic.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // The runtime's implementations of the two things that cannot be shared with the Worker build:
  // the native argon2 addon, and pdfkit. Installed before anything can serve a request, so a
  // missing backend is a boot failure rather than a 500 on someone's first login.
  setArgon2Backend(nodeArgon2);
  setPdfRenderer(renderCurriculumPdf);

  const content = loadContent();
  logger.info({ languages: [...content.keys()] }, 'content loaded');

  await connectDatabase(config, {
    onRetry: ({ attempt, attempts, delayMs, err }) => {
      logger.warn(
        {
          attempt,
          attempts,
          retryInMs: delayMs,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        'database connection failed, retrying',
      );
    },
  });
  logger.info({ maxPoolSize: config.MONGODB_MAX_POOL_SIZE }, 'database connected');

  // Before the port is bound, because two of these indexes are not optimisations: the unique
  // `(userId, monthKey)` on `month_archives` is what makes the rollover job safe to retry, and the
  // unique `email` is what refuses a duplicate registration. Serving without them would mean those
  // guarantees silently do not hold.
  await ensureIndexes(logger);

  const server = serve({ fetch: createApp(config, logger).fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, 'listening');
  });

  // After the port is bound: the scheduled jobs are background work and must not delay readiness.
  const scheduler = startScheduler(logger);

  // Drain in-flight requests, then release the pool, so a rolling deploy does not cut a request
  // in half or leave connections held on the Atlas side.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    server.close(() => {
      void closeDatabase().then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ err }, 'failed to close the database cleanly');
          process.exit(1);
        },
      );
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  // No logger yet if configuration itself failed, so this goes to stderr directly. The message is
  // the useful part — `loadConfig` lists every problem at once.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
