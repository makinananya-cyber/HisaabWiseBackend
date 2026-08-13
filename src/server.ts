import { serve } from '@hono/node-server';

import { loadConfig } from './config';
import { closeDatabase, connectDatabase } from './db';
import { createApp } from './index';
import { createLogger } from './logger';

/**
 * The entrypoint. Ordering here is the whole point:
 *
 *  1. Validate configuration — a bad environment fails before anything else happens.
 *  2. Connect the database — an unreachable cluster fails before a port is bound, so the platform
 *     health check never goes green on a process that cannot serve.
 *  3. Only then accept traffic.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  await connectDatabase(config);
  logger.info({ maxPoolSize: config.MONGODB_MAX_POOL_SIZE }, 'database connected');

  const server = serve({ fetch: createApp(config, logger).fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, 'listening');
  });

  // Drain in-flight requests, then release the pool, so a rolling deploy does not cut a request
  // in half or leave connections held on the Atlas side.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
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
