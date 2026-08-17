import { Hono } from 'hono';

import { ApiError } from '../errors';
import { requireSession } from '../middleware/auth';
import { latestRateSet, rateSetById, rateSetFor } from '../repositories/fxRates';
import { archivesForUser, findArchive } from '../repositories/monthArchives';
import { buildMonthReport, buildReports } from '../screens/reports';
import type { AppEnv } from '../types/hono';

/**
 * Reports — the archive, read.
 *
 * **The invariant-7 routes.** An archived month is immutable and carries the FX rate set pinned at close, so
 * a month read in a different display currency converts every figure through *those* rates and changes no
 * verdict. The pinning is what makes that true, and it is honoured here by reading `fxRateSetId` rather
 * than the newest set.
 */

export const reportRoutes = new Hono<AppEnv>();

/**
 * `GET /v1/screens/reports` — the whole archive, grouped by year.
 *
 * The **list** uses the newest rate set rather than each month's pinned one, and that is a deliberate
 * asymmetry: the trend chart compares months against each other, so they have to be in one currency at one
 * moment or the comparison is meaningless. The *verdicts* on those bars still come from the stored
 * documents, so no amount of FX movement can change whether a goal was met — which is the half of
 * invariant 7 that actually matters.
 */
reportRoutes.get('/v1/screens/reports', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');

  const [archives, rates] = await Promise.all([archivesForUser(c.var.user._id), latestRateSet()]);
  return c.json(buildReports(archives, c.var.user, rates));
});

/**
 * `GET /v1/screens/reports/:monthKey` — one closed month in full.
 *
 * Converted through the month's **pinned** rate set, falling back to the set in force on the day it closed
 * if the pinned one has somehow gone. That fallback is a data-integrity concession rather than a feature:
 * rate sets are never deleted, so reaching it means something is wrong, and reading the nearest historical
 * set is closer to the truth than reading today's.
 */
reportRoutes.get('/v1/screens/reports/:monthKey', requireSession(), async (c) => {
  const monthKey = c.req.param('monthKey');
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new ApiError('VALIDATION_FAILED', 'a month key looks like 2026-02');
  }

  const archive = await findArchive(c.var.user._id, monthKey);
  if (archive === null) throw new ApiError('NOT_FOUND', 'that month has not been closed');

  const pinned =
    archive.fxRateSetId === null
      ? undefined
      : ((await rateSetById(archive.fxRateSetId)) ??
        (await rateSetFor(archive.closedAt.toISOString().slice(0, 10))));

  c.header('Cache-Control', 'no-store');
  return c.json(buildMonthReport(archive, c.var.user, pinned));
});

/**
 * `GET /v1/fx/rates/:monthKey` — the rate set an archived month was closed with.
 *
 * Exposed because it is what makes a report's figures explicable: a reader who changes display currency and
 * sees a different number should be able to find out what rate produced it. **Cacheable and immutable** —
 * a pinned set never changes, so this is the one FX response that can be cached for a long time.
 */
reportRoutes.get('/v1/fx/rates/:monthKey', requireSession(), async (c) => {
  const monthKey = c.req.param('monthKey');
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new ApiError('VALIDATION_FAILED', 'a month key looks like 2026-02');
  }

  const archive = await findArchive(c.var.user._id, monthKey);
  if (archive === null) throw new ApiError('NOT_FOUND', 'that month has not been closed');

  const pinned = archive.fxRateSetId === null ? undefined : await rateSetById(archive.fxRateSetId);
  if (pinned === undefined) {
    throw new ApiError('NOT_FOUND', 'that month has no pinned rate set');
  }

  c.header('Cache-Control', 'private, max-age=86400, immutable');
  return c.json({ monthKey, dateKey: pinned.dateKey, base: pinned.base, rates: pinned.rates });
});
