import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rolloverUser } from '../src/jobs/monthRollover';
import { createLogger } from '../src/logger';
import { latestRateSet, writeRateSet } from '../src/repositories/fxRates';
import { archivedMonthKeys } from '../src/repositories/monthArchives';
import { findByEmail, type User } from '../src/repositories/users';
import { assertMatchesShape } from './contract/shape';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';
import { fixture } from './support/fixture';

/** Slice 6's read side: the archive list, one month in full, and the pinned rate set. */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[reports.test] skipped: ${skipReason}`);

describeIntegration('Reports', () => {
  let db: TestDatabase;
  const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' } as never);

  beforeAll(async () => {
    db = await setupDatabase();
    await db.clear();

    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { getContent } = await import('../src/content');
    const seed = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', 'content', 'fx-seed.json'), 'utf8'),
    ) as { rates: Record<string, number> };
    await writeRateSet(
      { dateKey: '2026-08-01', rates: seed.rates },
      getContent().currencies.value.currencies.map((currency) => currency.code),
      new Date(),
    );
  });

  afterAll(async () => {
    await db.drop();
  });

  async function account(): Promise<{ token: string; user: User }> {
    const email = `reports+${randomUUID()}@example.ae`;
    const response = await db.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ananya',
        email,
        dateOfBirth: '1994-06-20',
        password: 'a-good-enough-password',
        displayCurrency: 'INR',
        salary: { minor: 6_500_000, currency: 'INR' },
        savingsGoal: { minor: 1_300_000, currency: 'INR' },
        goalWasSkipped: false,
        securityAnswers: [
          { questionId: 'sq01', answer: 'Fluffy' },
          { questionId: 'sq02', answer: 'Jaipur' },
        ],
        acceptedTerms: true,
        timeZone: 'Asia/Kolkata',
        language: 'en',
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { accessToken } = (await response.json()) as { accessToken: string };
    return { token: accessToken, user: required(await findByEmail(email), 'the registered user') };
  }

  const write = async (method: string, path: string, token: string, body: unknown): Promise<Response> =>
    db.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const read = async (path: string, token: string): Promise<Response> =>
    db.app.request(path, { headers: { Authorization: `Bearer ${token}` } });

  const nextMonthInstant = (): Date => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15, 12, 0, 0));
  };

  /** An account with one closed month behind it. */
  async function withClosedMonth(): Promise<{ token: string; user: User; monthKey: string }> {
    const { token, user } = await account();

    await write('PUT', '/v1/expenses/fixed/rent', token, { amount: { minor: 2_696_000, currency: 'INR' } });
    await write('PUT', '/v1/expenses/lines/utilities', token, {
      lines: [{ name: 'Electricity', amount: { minor: 600_000, currency: 'INR' } }],
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'groceries',
      amount: { minor: 1_478_000, currency: 'INR' },
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'transport',
      amount: { minor: 335_000, currency: 'INR' },
      optionId: 'metro',
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'entertainment',
      amount: { minor: 81_000, currency: 'INR' },
      label: 'Cinema',
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'other',
      amount: { minor: 127_000, currency: 'INR' },
      optionId: 'medical',
    });

    await rolloverUser(user, nextMonthInstant(), await latestRateSet(), logger);
    const monthKey = required((await archivedMonthKeys(user._id))[0], 'the archived month');
    return { token, user, monthKey };
  }

  // ── The list ────────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/screens/reports', () => {
    it('satisfies the empty contract for an account with no closed months', async () => {
      const { token } = await account();
      const response = await read('/v1/screens/reports', token);

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('reports-empty.json'), await response.json(), 'GET /v1/screens/reports');
    });

    it('says so plainly when nothing has closed', async () => {
      const { token } = await account();
      const body = (await (await read('/v1/screens/reports', token)).json()) as {
        summary: { goalsMetLabel: string; monthCount: { value: number } };
        trend: { goalPosition: number; bars: unknown[] };
        years: unknown[];
      };

      expect(body.summary.goalsMetLabel).toBe('No months have closed yet');
      expect(body.summary.monthCount.value).toBe(0);
      expect(body.trend.bars).toEqual([]);
      expect(body.years).toEqual([]);
      // The goal line still needs somewhere to sit on an empty chart.
      expect(body.trend.goalPosition).toBe(0.8);
    });

    it('satisfies the populated contract once a month has closed', async () => {
      const { token } = await withClosedMonth();

      const response = await read('/v1/screens/reports', token);
      assertMatchesShape(fixture('reports-inr.json'), await response.json(), 'GET /v1/screens/reports');
    });

    it('carries a bar with no figure the client could threshold', async () => {
      const { token } = await withClosedMonth();
      const body = (await (await read('/v1/screens/reports', token)).json()) as {
        trend: {
          bars: {
            monthKey: string;
            label: string;
            fill: number;
            verdict: string;
            percentageLabel: string;
            accessibilityLabel: string;
          }[];
        };
      };

      const bar = required(body.trend.bars[0], 'a trend bar');
      // Defect D11 is two threshold tables for one pill. The client's half of the fix is having nothing to
      // threshold: no `saved`, no `goal`, and the percentage only as a rendered string.
      expect(bar).not.toHaveProperty('saved');
      expect(bar).not.toHaveProperty('goal');
      expect(['hit', 'near', 'miss']).toContain(bar.verdict);
      expect(bar.percentageLabel).toMatch(/^\d+% of goal$/);
      expect(bar.accessibilityLabel).toContain('% of goal');
      expect(bar.fill).toBeGreaterThan(0);
      expect(bar.fill).toBeLessThanOrEqual(1);
    });

    it('groups by year, newest first', async () => {
      const { token } = await withClosedMonth();
      const body = (await (await read('/v1/screens/reports', token)).json()) as {
        years: { label: string; totalSaved: { minor: number }; months: { monthKey: string }[] }[];
      };

      expect(body.years).toHaveLength(1);
      const year = required(body.years[0], 'a year');
      expect(year.label).toMatch(/^\d{4}$/);
      expect(year.months).toHaveLength(1);
      expect(year.totalSaved.minor).toBeGreaterThan(0);
    });

    it('is never cached', async () => {
      const { token } = await account();

      expect((await read('/v1/screens/reports', token)).headers.get('cache-control')).toContain('no-store');
    });
  });

  // ── One month ───────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/screens/reports/:monthKey', () => {
    it('satisfies the contract for one closed month', async () => {
      const { token, monthKey } = await withClosedMonth();

      const response = await read(`/v1/screens/reports/${monthKey}`, token);
      expect(response.status).toBe(200);
      assertMatchesShape(
        fixture('reports-month-inr.json'),
        await response.json(),
        'GET /v1/screens/reports/:monthKey',
      );
    });

    it('carries every category as a group, including the empty ones', async () => {
      const { token, monthKey } = await withClosedMonth();
      const body = (await (await read(`/v1/screens/reports/${monthKey}`, token)).json()) as {
        spending: { categories: unknown[]; categoryCountLabel: string };
        groups: { id: string; summaryLabel: string; entries: unknown[] }[];
      };

      // Seven groups, because a category with nothing in it is a fact about the month; the donut above shows
      // only what was spent. `reports-month-quiet.json` is that distinction at its extreme.
      expect(body.groups).toHaveLength(7);
      expect(body.spending.categories).toHaveLength(6);
      expect(body.spending.categoryCountLabel).toBe('6 categories');

      const income = required(
        body.groups.find((group) => group.id === 'income'),
        'the income group',
      );
      expect(income.entries).toEqual([]);
      expect(income.summaryLabel).toBe('Nothing recorded');
    });

    it('dates a fixed cost as the month rather than a day', async () => {
      const { token, monthKey } = await withClosedMonth();
      const body = (await (await read(`/v1/screens/reports/${monthKey}`, token)).json()) as {
        groups: { id: string; entries: { label: string; dateLabel: string }[] }[];
      };

      const rent = required(
        body.groups.find((group) => group.id === 'rent'),
        'the rent group',
      );
      expect(required(rent.entries[0], 'the rent entry').dateLabel).toBe('Fixed each month');
    });

    it('carries the four split segments, with no target on the surplus', async () => {
      const { token, monthKey } = await withClosedMonth();
      const body = (await (await read(`/v1/screens/reports/${monthKey}`, token)).json()) as {
        split: { segments: { portion: string; target?: unknown }[] };
      };

      expect(body.split.segments.map((segment) => segment.portion)).toEqual([
        'needs',
        'wants',
        'saved',
        'surplus',
      ]);
      // The surplus has no target, because there is nothing it is supposed to be.
      expect(required(body.split.segments[3], 'the surplus segment').target).toBeUndefined();
      expect(required(body.split.segments[0], 'the needs segment').target).toBeDefined();
    });

    it('carries the six facts in order', async () => {
      const { token, monthKey } = await withClosedMonth();
      const body = (await (await read(`/v1/screens/reports/${monthKey}`, token)).json()) as {
        facts: { kind: string; value: string; note?: string }[];
      };

      expect(body.facts.map((fact) => fact.kind)).toEqual([
        'salary',
        'goal',
        'saved',
        'biggestCost',
        'needs',
        'leftOver',
      ]);
      // Rent is the biggest cost in this month by a wide margin.
      expect(required(body.facts[3], 'the biggest-cost fact').value).toBe('Rent');
    });

    it('answers 404 for a month that has not closed', async () => {
      const { token } = await account();

      expect((await read('/v1/screens/reports/2020-01', token)).status).toBe(404);
    });

    it('refuses a month key that is not a month key', async () => {
      const { token } = await account();

      expect((await read('/v1/screens/reports/january', token)).status).toBe(422);
    });

    it('will not show another user\'s month', async () => {
      const { monthKey } = await withClosedMonth();
      const { token: stranger } = await account();

      expect((await read(`/v1/screens/reports/${monthKey}`, stranger)).status).toBe(404);
    });
  });

  // ── The pinned rate set ─────────────────────────────────────────────────────────────────────

  describe('GET /v1/fx/rates/:monthKey', () => {
    /**
     * Exposed because it is what makes a report's figures explicable: a reader who changes currency and sees
     * a different number should be able to find out which rate produced it.
     */
    it('serves the set the month was closed with, immutably', async () => {
      const { token, monthKey } = await withClosedMonth();

      const response = await read(`/v1/fx/rates/${monthKey}`, token);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { monthKey: string; base: string; rates: Record<string, number> };
      expect(body.monthKey).toBe(monthKey);
      expect(body.base).toBe('USD');
      expect(Object.keys(body.rates)).toHaveLength(160);
      // A pinned set never changes, so this is the one FX response that can be cached for a long time.
      expect(response.headers.get('cache-control')).toContain('immutable');
    });

    it('answers 404 for a month that has not closed', async () => {
      const { token } = await account();

      expect((await read('/v1/fx/rates/2020-01', token)).status).toBe(404);
    });
  });
});
