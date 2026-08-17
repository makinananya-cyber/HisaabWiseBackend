import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { monthDueFor, rolloverUser, runMonthRollover } from '../src/jobs/monthRollover';
import { createLogger } from '../src/logger';
import { latestRateSet, writeRateSet } from '../src/repositories/fxRates';
import { archivedMonthKeys, findArchive, insertArchive } from '../src/repositories/monthArchives';
import { findByEmail, type User } from '../src/repositories/users';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';

/**
 * **The rollover suite — a hard gate on every `main` merge that touches the job** (BACKEND_PLAN §4 slice 6).
 *
 * The month-rollover job writes immutable history and clears a month of a user's data. The five properties
 * below are the ones the plan names, and each is a specific way this could destroy something:
 *
 *  1. The archive holds salary, goal, saved and the full payload.
 *  2. The live month is cleared, and rent and utility lines are carried forward.
 *  3. **Run twice → the second writes nothing.**
 *  4. **Skip a run, then run late → the missed user is still archived.**
 *  5. **Changing display currency converts the figures but never changes a goal-hit verdict.**
 */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[rollover.test] skipped: ${skipReason}`);

describeIntegration('month rollover', () => {
  let db: TestDatabase;
  const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' } as never);

  beforeAll(async () => {
    db = await setupDatabase();
    await db.clear();
    await seedRates();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function seedRates(): Promise<void> {
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
  }

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────

  interface Account {
    token: string;
    user: User;
    email: string;
  }

  /** A registered account, with a month of real spending behind it. */
  async function account(overrides: Record<string, unknown> = {}): Promise<Account> {
    const email = `rollover+${randomUUID()}@example.ae`;
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
        ...overrides,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { accessToken } = (await response.json()) as { accessToken: string };

    return { token: accessToken, user: required(await findByEmail(email), 'the registered user'), email };
  }

  const write = async (method: string, path: string, token: string, body: unknown): Promise<Response> =>
    db.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  /** Give an account a month worth archiving: rent, bills, groceries, a taxi and some freelance income. */
  async function populate(token: string): Promise<void> {
    await write('PUT', '/v1/expenses/fixed/rent', token, { amount: { minor: 3_000_000, currency: 'INR' } });
    await write('PUT', '/v1/expenses/lines/utilities', token, {
      lines: [
        { name: 'Electricity', amount: { minor: 340_000, currency: 'INR' } },
        { name: 'Water', amount: { minor: 48_000, currency: 'INR' } },
      ],
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'groceries',
      amount: { minor: 860_000, currency: 'INR' },
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'transport',
      amount: { minor: 440_000, currency: 'INR' },
      optionId: 'taxi',
    });
    await write('POST', '/v1/expenses', token, {
      categoryId: 'income',
      amount: { minor: 90_000, currency: 'INR' },
      label: 'Freelance design work',
    });
  }

  /**
   * A moment inside the month *after* the current one — mid-month and midday, so no timezone in the target
   * market can put it in a different month from any other.
   *
   * Time is injected rather than mocked: `rolloverUser` takes `now`, which is what lets the whole
   * catch-up story be tested without touching a clock.
   */
  const nextMonthInstant = (): Date => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15, 12, 0, 0));
  };

  const read = async (path: string, token: string): Promise<Response> =>
    db.app.request(path, { headers: { Authorization: `Bearer ${token}` } });

  // ── Selection ───────────────────────────────────────────────────────────────────────────────

  describe('selection is catch-up-safe', () => {
    it('has nothing due while the user is still inside their first month', async () => {
      const { user } = await account();

      expect(monthDueFor(user, new Date(), [])).toBeUndefined();
    });

    it('has the previous month due once the local clock moves on', async () => {
      const { user } = await account();
      const now = new Date();
      const thisMonth = `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      expect(monthDueFor(user, nextMonthInstant(), [])).toBe(thisMonth);
    });

    it('has nothing due once that month is archived', async () => {
      const { user } = await account();
      const due = required(monthDueFor(user, nextMonthInstant(), []), 'a due month');

      expect(monthDueFor(user, nextMonthInstant(), [due])).toBeUndefined();
    });

    /**
     * **The property that matters most.** A skipped run, a deploy over midnight, or a sleeping machine must
     * not lose a month. Selection asks "is there an unarchived month behind us", never "did we cross a
     * boundary in the last hour" — so a run three months late files all three, oldest first.
     */
    it('files the oldest missed month first when several runs were skipped', async () => {
      const { user } = await account();
      const now = new Date();
      const threeMonthsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 15, 12, 0, 0));

      const first = required(monthDueFor(user, threeMonthsOn, []), 'the first missed month');
      const second = required(monthDueFor(user, threeMonthsOn, [first]), 'the second missed month');
      const third = required(monthDueFor(user, threeMonthsOn, [first, second]), 'the third missed month');

      expect(first < second).toBe(true);
      expect(second < third).toBe(true);
      // And once all three are filed, nothing more is due.
      expect(monthDueFor(user, threeMonthsOn, [first, second, third])).toBeUndefined();
    });

    it('never considers a month before the account existed', async () => {
      const { user } = await account();

      // Without this bound a user who registered today would have every month since the epoch due.
      const due = required(monthDueFor(user, nextMonthInstant(), []), 'a due month');
      expect(due >= `${String(user.createdAt.getUTCFullYear())}-01`).toBe(true);
    });
  });

  // ── What the archive holds ──────────────────────────────────────────────────────────────────

  describe('the archive', () => {
    it('holds salary, goal, saved, the verdict, and the full payload', async () => {
      const { token, user } = await account();
      await populate(token);
      const at = nextMonthInstant();

      const outcome = await rolloverUser(user, at, await latestRateSet(), logger);
      expect(outcome).toBe('archived');

      const due = required(
        (await archivedMonthKeys(user._id))[0],
        'the archived month',
      );
      const archive = required(await findArchive(user._id, due), 'the archive document');

      expect(archive.salary).toEqual({ minor: 6_500_000, currency: 'INR', exponent: 2 });
      expect(archive.goal).toEqual({ minor: 1_300_000, currency: 'INR', exponent: 2 });
      // income 65,900 − needs (30,000 + 3,880 + 8,600) − wants 4,400 = 18,020
      expect(archive.saved.minor).toBe(6_590_000 - 4_248_000 - 440_000);
      expect(archive.net.minor).toBe(archive.saved.minor);
      expect(archive.verdict).toBe('hit');
      // Three logged entries: groceries, transport, income. Rent and bills live on `fixed`.
      expect(archive.entries).toHaveLength(3);
      expect(archive.fixed.rent.minor).toBe(3_000_000);
      expect(archive.fixed.utilityLines).toHaveLength(2);
      // Pinned, so this month converts through these rates forever (invariant 7).
      expect(archive.fxRateSetId).not.toBeNull();
    });

    it('carries a full timestamp on every entry, not a day of the month', async () => {
      const { token, user } = await account();
      await populate(token);
      await rolloverUser(user, nextMonthInstant(), await latestRateSet(), logger);

      const due = required((await archivedMonthKeys(user._id))[0], 'the archived month');
      const archive = required(await findArchive(user._id, due), 'the archive');

      for (const entry of archive.entries) {
        // The prototype stored a day-of-month, which cannot order two entries within one day.
        expect(entry.entryDate).toBeInstanceOf(Date);
        expect(entry.entryDate.getUTCHours()).toBeGreaterThanOrEqual(0);
      }
    });

    it('clears the live month and carries the fixed costs forward', async () => {
      const { token, user } = await account();
      await populate(token);
      await rolloverUser(user, nextMonthInstant(), await latestRateSet(), logger);

      const screen = (await (await read('/v1/screens/expenses', token)).json()) as {
        categories: { id: string; total: { minor: number }; entries?: unknown[]; lines?: unknown[] }[];
      };
      const categoryOf = (id: string): (typeof screen.categories)[number] =>
        required(
          screen.categories.find((category) => category.id === id),
          id,
        );

      // Logged entries gone.
      expect(categoryOf('groceries').total.minor).toBe(0);
      expect(categoryOf('groceries').entries).toEqual([]);
      expect(categoryOf('income').total.minor).toBe(0);

      // Rent and bills carried forward **unchanged** — they live on their own document, so the next month
      // inherits them without a copy. That is exactly why they are a separate collection.
      expect(categoryOf('rent').total.minor).toBe(3_000_000);
      expect(categoryOf('utilities').total.minor).toBe(388_000);
      expect(categoryOf('utilities').lines).toHaveLength(2);
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────────────────────

  describe('running twice', () => {
    /**
     * The second pass does not even attempt the write: once the archive exists the month is no longer due, so
     * selection reports `nothingDue`. `alreadyArchived` is reserved for the genuine race — two instances
     * computing the same due month and both trying to insert — which the unique index resolves.
     */
    it('writes nothing the second time', async () => {
      const { token, user } = await account();
      await populate(token);
      const at = nextMonthInstant();
      const rates = await latestRateSet();

      expect(await rolloverUser(user, at, rates, logger)).toBe('archived');
      const afterFirst = await archivedMonthKeys(user._id);

      expect(await rolloverUser(user, at, rates, logger)).toBe('nothingDue');
      expect(await archivedMonthKeys(user._id)).toEqual(afterFirst);
    });

    it('does not double-clear or double-count when the whole pass runs twice', async () => {
      const { token, user } = await account();
      await populate(token);
      const at = nextMonthInstant();

      await rolloverUser(user, at, await latestRateSet(), logger);
      const due = required((await archivedMonthKeys(user._id))[0], 'the archived month');
      const first = required(await findArchive(user._id, due), 'the archive');

      await rolloverUser(user, at, await latestRateSet(), logger);
      const second = required(await findArchive(user._id, due), 'the archive');

      // Byte-identical: the second pass did not touch it.
      expect(second.saved).toEqual(first.saved);
      expect(second.entries).toEqual(first.entries);
      expect(second.closedAt.getTime()).toBe(first.closedAt.getTime());
    });

    /**
     * A retry that lands **mid-write** — the archive written but the month not yet cleared. The next run must
     * skip the write and clear, never write again and never leave the month live forever.
     */
    it('recovers from a crash between writing the archive and clearing the month', async () => {
      const { token, user } = await account();
      await populate(token);
      const at = nextMonthInstant();
      const rates = await latestRateSet();

      // Simulate the crash: write the archive by hand, leaving the entries in place.
      const due = required(monthDueFor(user, at, []), 'a due month');
      const wrote = await insertArchive({
        userId: user._id,
        monthKey: due,
        salary: user.salary,
        goal: user.savingsGoal,
        saved: user.salary,
        net: user.salary,
        verdict: 'hit',
        adapted: false,
        entries: [],
        fixed: { rent: user.salary, utilityLines: [] },
        fxRateSetId: null,
        closedAt: at,
      });
      expect(wrote).toBe(true);

      // The month is no longer *due* — the archive exists. The pass must still clear the orphaned entries,
      // because nothing else ever will: they sit in a month too closed to delete from by any other route.
      // This is the bug this test found; the first version cleared only the month it had just archived.
      expect(await rolloverUser(user, at, rates, logger)).toBe('tidied');

      const { entriesForMonth } = await import('../src/repositories/expenseEntries');
      expect(await entriesForMonth(user._id, due)).toEqual([]);

      // And the archive was not overwritten — it is immutable, even by the job that lost its nerve.
      const archive = required(await findArchive(user._id, due), 'the archive');
      expect(archive.entries).toEqual([]);
    });

    it('is a no-op once there is nothing left to tidy', async () => {
      const { token, user } = await account();
      await populate(token);
      const at = nextMonthInstant();
      const rates = await latestRateSet();

      await rolloverUser(user, at, rates, logger);
      expect(await rolloverUser(user, at, rates, logger)).toBe('nothingDue');
      expect(await rolloverUser(user, at, rates, logger)).toBe('nothingDue');
    });
  });

  // ── The whole pass ──────────────────────────────────────────────────────────────────────────

  describe('a full pass', () => {
    it('archives nothing when nothing is due', async () => {
      await account();

      const outcome = await runMonthRollover(logger, new Date());

      expect(outcome.archived).toBe(0);
    });

    it(
      'archives every user with a month behind them, and reports the counts',
      async () => {
        const first = await account();
        const second = await account();
        await populate(first.token);
        await populate(second.token);

        const outcome = await runMonthRollover(logger, nextMonthInstant());

        expect(outcome.archived).toBeGreaterThanOrEqual(2);
        expect(outcome.failed).toBe(0);
        expect(await archivedMonthKeys(first.user._id)).toHaveLength(1);
        expect(await archivedMonthKeys(second.user._id)).toHaveLength(1);
      },
      // A whole pass walks **every** user this suite has created, sequentially, and each one is several
      // Atlas round trips. That is the job's real cost and the reason it runs on a timer rather than inline.
      120_000,
    );
  });

  // ── Invariant 7 ─────────────────────────────────────────────────────────────────────────────

  describe('an archived month is immutable', () => {
    /**
     * **The invariant-7 test, and the reason `saved`/`net`/`verdict`/`adapted` are stored rather than
     * derived.** Changing display currency must convert the figures without ever changing the story: a met
     * goal stays met. Recomputing them against a different rate set could flip a `hit` to a `near`, which is
     * defect D6.
     */
    it('converts the figures when the display currency changes, and keeps the verdict', async () => {
      const { token, user } = await account();
      await populate(token);
      await rolloverUser(user, nextMonthInstant(), await latestRateSet(), logger);

      const due = required((await archivedMonthKeys(user._id))[0], 'the archived month');

      const inRupees = (await (await read(`/v1/screens/reports/${due}`, token)).json()) as {
        verdict: string;
        percentageLabel: string;
        savings: { saved: { minor: number; currency: string; display: string } };
      };

      // Switch the display currency directly on the user document — the account route lands in slice 7.
      const { setDisplayCurrency } = await import('../src/repositories/users');
      await setDisplayCurrency(user._id, 'AED');

      const inDirhams = (await (await read(`/v1/screens/reports/${due}`, token)).json()) as typeof inRupees;

      // The figures converted...
      expect(inDirhams.savings.saved.currency).toBe('AED');
      expect(inDirhams.savings.saved.minor).not.toBe(inRupees.savings.saved.minor);
      expect(inDirhams.savings.saved.display).toMatch(/^AED /);
      // ...and the story did not.
      expect(inDirhams.verdict).toBe(inRupees.verdict);
      expect(inDirhams.percentageLabel).toBe(inRupees.percentageLabel);
    });

    /**
     * The `MONTH_CLOSED` guard, exercised through the one state that reaches it.
     *
     * This test archives the user's *current* calendar month by running the job from a future instant —
     * something production never does, because the job only ever closes a month the clock has left. That
     * puts the live month one ahead of `now`, so a write dated now targets a sealed month and is refused.
     *
     * It is worth having exactly because it is the state a **clock going backwards** would produce: a device
     * whose zone moved west across a boundary. The rule that the live month only moves forward is what keeps
     * the archive safe, and this is the refusal that rule implies.
     */
    it('refuses to write into a closed month', async () => {
      const { token, user } = await account();
      await populate(token);
      await rolloverUser(user, nextMonthInstant(), await latestRateSet(), logger);

      const due = required((await archivedMonthKeys(user._id))[0], 'the archived month');

      const response = await write('POST', '/v1/expenses', token, {
        categoryId: 'groceries',
        amount: { minor: 10_000, currency: 'INR' },
      });

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('MONTH_CLOSED');

      // And the archive is untouched — archives are immutable with no exceptions (defect D6).
      const stillSealed = required(await findArchive(user._id, due), 'the archive');
      expect(stillSealed.entries).toHaveLength(3);
    });
  });
});
