import type { AppLogger } from './logging';

import { runMonthRollover } from './jobs/monthRollover';
import { runPurgeDeleted } from './jobs/purgeDeleted';

/**
 * The in-process scheduler, replacing ADR-0007's Cron Triggers → Queues.
 *
 * The fan-out to a queue was there because a Workers cron handler is CPU-limited to 10 ms; on a long-lived
 * Node process that constraint is gone, so a timer is enough. **`month:rollover` keeps its per-user
 * structure anyway** — that was never really about CPU limits, it is what gives per-user retries on the job
 * that writes immutable history.
 *
 * Three properties this deliberately has:
 *
 * **A run never overlaps itself.** Each job is scheduled by `setTimeout` *after* the previous run finishes,
 * not by `setInterval`. A rollover that takes longer than its interval — a large user table, a slow Atlas
 * moment — would otherwise start a second pass over the same users. The unique index makes that safe rather
 * than corrupting, but it is still wasted work and doubled load at exactly the wrong time.
 *
 * **A failure does not stop the schedule.** An unhandled error in one pass is logged and the next is
 * scheduled. A scheduler that dies on the first bad document is worse than one that retries.
 *
 * **It is opt-in per process.** `startScheduler` is called from the entrypoint only, so a test or a script
 * that builds an app does not silently start writing archives.
 *
 * The obvious limitation, stated rather than discovered: **this runs in every instance.** Two instances
 * means two passes, which the unique `(userId, monthKey)` index makes harmless — both try, one wins — but it
 * is duplicated work. If this ever runs at more than one instance, move to a leader lock or an external
 * scheduler; the job itself needs no change, because it is already safe to run twice.
 */

/** Fifteen minutes. Not hourly: Asia/Kolkata is +05:30 and Asia/Kathmandu +05:45 (Product Spec §4.5). */
export const ROLLOVER_INTERVAL_MS = 15 * 60 * 1_000;

/**
 * Daily, for the purge.
 *
 * A thirty-day grace period does not need finer granularity than a day: an account erased twelve hours later
 * than its cutoff is thirty days and twelve hours old, which is not a promise anybody made differently.
 */
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  run(logger: AppLogger): Promise<unknown>;
}

const JOBS: ScheduledJob[] = [
  {
    name: 'month:rollover',
    intervalMs: ROLLOVER_INTERVAL_MS,
    run: async (logger) => runMonthRollover(logger),
  },
  {
    name: 'purge:deleted',
    intervalMs: PURGE_INTERVAL_MS,
    run: async (logger) => runPurgeDeleted(logger),
  },
];

export interface RunningScheduler {
  stop(): void;
}

/**
 * Start every job, and return a handle that stops them.
 *
 * The first run is delayed by one interval rather than firing at boot: a deploy that rolls several instances
 * would otherwise have all of them run at once, and there is nothing time-critical about the first pass —
 * catch-up-safe selection means a month due at boot is still due fifteen minutes later.
 */
export function startScheduler(logger: AppLogger): RunningScheduler {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  for (const job of JOBS) {
    const schedule = (): void => {
      if (stopped) return;

      const timer = setTimeout(() => {
        void (async () => {
          try {
            await job.run(logger.child({ job: job.name }));
          } catch (err) {
            logger.error({ err, job: job.name }, 'scheduled job failed');
          } finally {
            // Scheduled *after* the run, so a slow pass cannot overlap the next one.
            schedule();
          }
        })();
      }, job.intervalMs);

      // Do not hold the process open on this timer alone: a `SIGTERM` should drain requests and exit, not
      // wait fifteen minutes for a timer nobody is waiting on.
      timer.unref();
      timers.push(timer);
    };

    schedule();
    logger.info({ job: job.name, intervalMs: job.intervalMs }, 'job scheduled');
  }

  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
