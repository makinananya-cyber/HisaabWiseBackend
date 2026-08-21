import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertMatchesShape } from './contract/shape';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';
import { fixture } from './support/fixture';

/**
 * Slice 4's integration test — Expenses end to end.
 *
 * Four properties this suite exists to hold:
 *
 *  1. **Logging and deleting an entry updates every figure on both Home and Expenses from server truth.**
 *     The client never patches its own copy, so the two screens cannot disagree about one month — which is
 *     precisely what the prototype's Home and Expenses did (defect D1).
 *  2. **Date labels come from the server**, computed in the stored timezone (defect D5).
 *  3. **A replayed create does not double-count**, via the client-supplied `_id` (ADR-0011).
 *  4. **The stored label is resolved from the option id**, never taken from the client — otherwise an
 *     Arabic reader files entries labelled in Arabic with nothing to reconcile them against.
 */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[expenses.test] skipped: ${skipReason}`);

describeIntegration('Expenses', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await setupDatabase();
    await db.clear();
  });

  afterAll(async () => {
    await db.drop();
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────

  async function register(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await db.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ananya',
        email: `expenses+${randomUUID()}@example.ae`,
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
    return accessToken;
  }

  interface Screen {
    monthLabel: string;
    summary: {
      total: { minor: number; display: string };
      fixed: { minor: number };
      variable: { minor: number };
      income: { minor: number; display: string };
    };
    wants: {
      used: { minor: number };
      allowance: { minor: number; display: string };
      percentageLabel: string;
      fill: number;
      isOver: boolean;
      sharePercent: number | null;
      options: { percent: number; allowance: { minor: number; display: string } }[];
    };
    entry: { code: string; symbol: string; displayCode: string; exponent: number };
    categories: {
      id: string;
      name: string;
      hint: string;
      total: { minor: number; display: string };
      entryCountLabel?: string;
      kind: string;
      flow: string;
      icon: string;
      field?: string;
      entries?: { id: string; label: string; amount: { minor: number }; dateLabel: string }[];
      lines?: { id: string; name: string; amount: { minor: number }; icon: string }[];
    }[];
  }

  const request = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    db.app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const screenOf = async (response: Response): Promise<Screen> => {
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return (await response.json()) as Screen;
  };

  const expenses = async (token: string): Promise<Screen> =>
    screenOf(await request('GET', '/v1/screens/expenses', token));

  const categoryOf = (screen: Screen, id: string): Screen['categories'][number] =>
    required(
      screen.categories.find((category) => category.id === id),
      `the ${id} category`,
    );

  const log = async (
    token: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Screen> =>
    screenOf(
      await request(
        'POST',
        '/v1/expenses',
        token,
        body,
        idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey },
      ),
    );

  // ── The contract ────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/screens/expenses', () => {
    it('satisfies the first-run contract for a new account', async () => {
      const token = await register();
      const response = await request('GET', '/v1/screens/expenses', token);

      expect(response.status).toBe(200);
      assertMatchesShape(
        fixture('expenses-first-run.json'),
        await response.json(),
        'GET /v1/screens/expenses',
      );
    });

    it('satisfies the populated contract once entries exist', async () => {
      const token = await register();
      await log(token, { categoryId: 'groceries', amount: { minor: 52_000, currency: 'INR' } });
      await log(token, {
        categoryId: 'transport',
        amount: { minor: 12_000, currency: 'INR' },
        optionId: 'metro',
      });
      await request('PUT', '/v1/expenses/fixed/rent', token, { amount: { minor: 300_000, currency: 'INR' } });
      await request('PUT', '/v1/expenses/lines/utilities', token, {
        lines: [{ name: 'Electricity', amount: { minor: 34_000, currency: 'INR' } }],
      });

      const response = await request('GET', '/v1/screens/expenses', token);
      assertMatchesShape(fixture('expenses-inr.json'), await response.json(), 'GET /v1/screens/expenses');
    });

    it('carries the seven categories in the design\'s order, with their kinds', async () => {
      const screen = await expenses(await register());

      expect(screen.categories.map((category) => category.id)).toEqual([
        'groceries',
        'transport',
        'entertainment',
        'other',
        'income',
        'utilities',
        'rent',
      ]);
      expect(screen.categories.map((category) => category.kind)).toEqual([
        'log', 'log', 'log', 'log', 'log', 'lines', 'fixed',
      ]);
      // `income` is the only inbound category — it is *additional* income, never salary.
      expect(screen.categories.map((category) => category.flow)).toEqual([
        'out', 'out', 'out', 'out', 'in', 'out', 'out',
      ]);
    });

    it('carries an entry count only for the log categories', async () => {
      const screen = await expenses(await register());

      for (const id of ['groceries', 'transport', 'entertainment', 'other', 'income']) {
        expect(categoryOf(screen, id).entryCountLabel, id).toBe('0 entries');
      }
      // A fixed cost has no entries to count, which is why the client's field is optional.
      expect(categoryOf(screen, 'utilities').entryCountLabel).toBeUndefined();
      expect(categoryOf(screen, 'rent').entryCountLabel).toBeUndefined();
    });

    it('carries the authoring currency the entry form uses', async () => {
      const screen = await expenses(await register());

      // The same token rule as every `display` string, so the form and the figures it produces cannot
      // disagree about what currency this is.
      expect(screen.entry).toEqual({ code: 'INR', symbol: '₹', displayCode: 'INR', exponent: 2 });
    });

    it('is never cached', async () => {
      const token = await register();
      const response = await request('GET', '/v1/screens/expenses', token);

      expect(response.headers.get('cache-control')).toContain('no-store');
    });
  });

  // ── Writing ─────────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/expenses', () => {
    it('answers with the updated screen, so the client patches nothing', async () => {
      const token = await register();

      const screen = await log(token, {
        categoryId: 'groceries',
        amount: { minor: 52_000, currency: 'INR' },
      });

      expect(categoryOf(screen, 'groceries').total.minor).toBe(52_000);
      expect(categoryOf(screen, 'groceries').entryCountLabel).toBe('1 entry');
      expect(screen.summary.total.minor).toBe(52_000);
      expect(screen.summary.variable.minor).toBe(52_000);
    });

    /**
     * The label is the **option's name**, resolved from its id. Sending the displayed name would mean an
     * Arabic-reading user filing an entry labelled in Arabic and an English-reading one filing the same
     * entry labelled in English, with nothing to reconcile them.
     */
    it('resolves a pick-list label from the option id', async () => {
      const token = await register();

      const screen = await log(token, {
        categoryId: 'transport',
        amount: { minor: 12_000, currency: 'INR' },
        optionId: 'metro',
      });

      const entries = required(categoryOf(screen, 'transport').entries, 'the transport entries');
      expect(entries[0]?.label).toBe('Metro / subway');
    });

    it('refuses an option id that is not in the list', async () => {
      const token = await register();

      const response = await request('POST', '/v1/expenses', token, {
        categoryId: 'transport',
        amount: { minor: 12_000, currency: 'INR' },
        optionId: 'teleportation',
      });

      expect(response.status).toBe(422);
    });

    it('lets the reader\'s own words win for the free-text option', async () => {
      const token = await register();

      const screen = await log(token, {
        categoryId: 'other',
        amount: { minor: 41_000, currency: 'INR' },
        optionId: 'something-else',
        label: 'Visa renewal',
      });

      const entries = required(categoryOf(screen, 'other').entries, 'the other entries');
      // That is the whole purpose of `opensFreeText` — the one option whose behaviour differs.
      expect(entries[0]?.label).toBe('Visa renewal');
    });

    it('accepts free text for a text field and falls back to the category name', async () => {
      const token = await register();

      const withText = await log(token, {
        categoryId: 'entertainment',
        amount: { minor: 30_000, currency: 'INR' },
        label: 'Cinema — Reel Cinemas',
      });
      expect(required(withText.categories[2]?.entries, 'entries')[0]?.label).toBe('Cinema — Reel Cinemas');

      // `source` on additional income is optional, so an unlabelled entry gets the category's own name.
      const withoutText = await log(token, {
        categoryId: 'income',
        amount: { minor: 90_000, currency: 'INR' },
      });
      const incomeEntries = required(categoryOf(withoutText, 'income').entries, 'income entries');
      expect(incomeEntries[0]?.label).toBe('Additional Income');
    });

    it('refuses a non-log category', async () => {
      const token = await register();

      // Rent is edited in place, not appended to — logging into it would create a second rent for the
      // month with nothing to reconcile the two.
      const response = await request('POST', '/v1/expenses', token, {
        categoryId: 'rent',
        amount: { minor: 300_000, currency: 'INR' },
      });

      expect(response.status).toBe(422);
    });

    it('refuses a zero or negative amount', async () => {
      const token = await register();

      for (const minor of [0, -100]) {
        const response = await request('POST', '/v1/expenses', token, {
          categoryId: 'groceries',
          amount: { minor, currency: 'INR' },
        });
        expect(response.status, String(minor)).toBe(422);
      }
    });

    /** ADR-0011: the client-supplied id *is* the idempotency mechanism, and it has no expiry. */
    it('does not double-count a replayed create', async () => {
      const token = await register();
      const key = randomUUID();
      const body = { categoryId: 'groceries', amount: { minor: 52_000, currency: 'INR' } };

      const first = await log(token, body, key);
      const replay = await log(token, body, key);

      expect(categoryOf(first, 'groceries').total.minor).toBe(52_000);
      // The replay is a **success** carrying the current screen: a client that merely lost the first
      // response must not be shown an error for a write that worked.
      expect(categoryOf(replay, 'groceries').total.minor).toBe(52_000);
      expect(categoryOf(replay, 'groceries').entryCountLabel).toBe('1 entry');
    });

    it('files two genuinely separate entries when the keys differ', async () => {
      const token = await register();
      const body = { categoryId: 'groceries', amount: { minor: 10_000, currency: 'INR' } };

      await log(token, body, randomUUID());
      const screen = await log(token, body, randomUUID());

      // Two ₹100 coffees are two entries. Deriving a key from the body would silently collapse them.
      expect(categoryOf(screen, 'groceries').entryCountLabel).toBe('2 entries');
      expect(categoryOf(screen, 'groceries').total.minor).toBe(20_000);
    });

    it('labels today\'s entry "Today"', async () => {
      const token = await register();

      const screen = await log(token, {
        categoryId: 'groceries',
        amount: { minor: 52_000, currency: 'INR' },
      });

      // Computed from two day keys in the stored zone, not from a device clock (defect D5).
      const entries = required(categoryOf(screen, 'groceries').entries, 'the groceries entries');
      expect(entries[0]?.dateLabel).toBe('Today');
    });

    it('shows additional income with a plus, because it is the only inbound category', async () => {
      const token = await register();

      const screen = await log(token, {
        categoryId: 'income',
        amount: { minor: 90_000, currency: 'INR' },
      });

      // The plus is on the **category row**, where it sits among six outgoing rows and a reader would
      // otherwise have no way to tell it from an expense of the same size. The summary's own `income`
      // field is already labelled as income, so `expenses-inr.json` carries it unsigned there — and the
      // two together are the design being precise rather than inconsistent.
      expect(categoryOf(screen, 'income').total.display).toBe('+₹900');
      expect(screen.summary.income.display).toBe('₹900');
    });
  });

  describe('DELETE /v1/expenses/:id', () => {
    it('removes the entry and answers with the updated screen', async () => {
      const token = await register();
      const afterCreate = await log(token, {
        categoryId: 'groceries',
        amount: { minor: 52_000, currency: 'INR' },
      });
      const id = required(required(categoryOf(afterCreate, 'groceries').entries, 'entries')[0], 'an entry').id;

      const screen = await screenOf(await request('DELETE', `/v1/expenses/${id}`, token));

      expect(categoryOf(screen, 'groceries').total.minor).toBe(0);
      expect(categoryOf(screen, 'groceries').entryCountLabel).toBe('0 entries');
      expect(screen.summary.total.minor).toBe(0);
    });

    it('answers 404 for an id that does not exist', async () => {
      const token = await register();

      const response = await request('DELETE', `/v1/expenses/${randomUUID()}`, token);

      expect(response.status).toBe(404);
    });

    /** The `userId` in the filter is not belt and braces: a leaked UUID must not delete another user's row. */
    it('will not delete another user\'s entry', async () => {
      const owner = await register();
      const stranger = await register();
      const created = await log(owner, {
        categoryId: 'groceries',
        amount: { minor: 52_000, currency: 'INR' },
      });
      const id = required(required(categoryOf(created, 'groceries').entries, 'entries')[0], 'an entry').id;

      const response = await request('DELETE', `/v1/expenses/${id}`, stranger);
      expect(response.status).toBe(404);

      // And it is still there for its owner.
      expect(categoryOf(await expenses(owner), 'groceries').entryCountLabel).toBe('1 entry');
    });
  });

  // ── Fixed costs and bill lines ──────────────────────────────────────────────────────────────

  describe('PUT /v1/expenses/fixed/:categoryId', () => {
    it('sets the rent and answers with the updated screen', async () => {
      const token = await register();

      const screen = await screenOf(
        await request('PUT', '/v1/expenses/fixed/rent', token, {
          amount: { minor: 300_000, currency: 'INR' },
        }),
      );

      expect(categoryOf(screen, 'rent').total.display).toBe('₹3,000');
      expect(screen.summary.fixed.minor).toBe(300_000);
      expect(screen.summary.total.minor).toBe(300_000);
    });

    it('replaces rather than accumulates, because rent is edited in place', async () => {
      const token = await register();
      await request('PUT', '/v1/expenses/fixed/rent', token, { amount: { minor: 300_000, currency: 'INR' } });

      const screen = await screenOf(
        await request('PUT', '/v1/expenses/fixed/rent', token, {
          amount: { minor: 350_000, currency: 'INR' },
        }),
      );

      expect(categoryOf(screen, 'rent').total.minor).toBe(350_000);
    });

    it('refuses a category that is not a fixed cost', async () => {
      const token = await register();

      const response = await request('PUT', '/v1/expenses/fixed/groceries', token, {
        amount: { minor: 100, currency: 'INR' },
      });

      expect(response.status).toBe(422);
    });
  });

  describe('PUT /v1/expenses/lines/:categoryId', () => {
    it('replaces the whole set, so a deleted line is expressible', async () => {
      const token = await register();
      await request('PUT', '/v1/expenses/lines/utilities', token, {
        lines: [
          { name: 'Electricity', amount: { minor: 34_000, currency: 'INR' } },
          { name: 'Water', amount: { minor: 4_800, currency: 'INR' } },
          { name: 'Phone / data', amount: { minor: 14_100, currency: 'INR' } },
        ],
      });

      const screen = await screenOf(
        await request('PUT', '/v1/expenses/lines/utilities', token, {
          lines: [{ name: 'Electricity', amount: { minor: 34_000, currency: 'INR' } }],
        }),
      );

      const lines = required(categoryOf(screen, 'utilities').lines, 'the utility lines');
      expect(lines).toHaveLength(1);
      expect(categoryOf(screen, 'utilities').total.minor).toBe(34_000);
    });

    it('mints a stable id for a new line and keeps one it was given', async () => {
      const token = await register();

      const first = await screenOf(
        await request('PUT', '/v1/expenses/lines/utilities', token, {
          lines: [{ name: 'Electricity', amount: { minor: 34_000, currency: 'INR' } }],
        }),
      );
      const id = required(required(categoryOf(first, 'utilities').lines, 'lines')[0], 'a line').id;
      expect(id.length).toBeGreaterThan(0);

      // A rename must not change the line's identity — that is what lets the archive carry it forward.
      const renamed = await screenOf(
        await request('PUT', '/v1/expenses/lines/utilities', token, {
          lines: [{ id, name: 'DEWA', amount: { minor: 36_000, currency: 'INR' } }],
        }),
      );
      const line = required(required(categoryOf(renamed, 'utilities').lines, 'lines')[0], 'a line');
      expect(line.id).toBe(id);
      expect(line.name).toBe('DEWA');
    });

    it('derives an icon from the line name, falling back to a generic tag', async () => {
      const token = await register();

      const screen = await screenOf(
        await request('PUT', '/v1/expenses/lines/utilities', token, {
          lines: [
            { name: 'Electricity', amount: { minor: 34_000, currency: 'INR' } },
            { name: 'Water', amount: { minor: 4_800, currency: 'INR' } },
            { name: 'Phone / data', amount: { minor: 14_100, currency: 'INR' } },
            { name: 'Building service charge', amount: { minor: 5_000, currency: 'INR' } },
          ],
        }),
      );

      const lines = required(categoryOf(screen, 'utilities').lines, 'the utility lines');
      expect(lines.map((line) => line.icon)).toEqual(['bolt', 'drop', 'signal', 'tag']);
    });

    it('refuses a category that does not hold bill lines', async () => {
      const token = await register();

      const response = await request('PUT', '/v1/expenses/lines/rent', token, { lines: [] });

      expect(response.status).toBe(422);
    });
  });

  // ── The wants bar ───────────────────────────────────────────────────────────────────────────

  describe('the wants bar', () => {
    /**
     * The allowance comes from the **budget engine**, not from a local 30%-of-salary calculation, so
     * additional income lifts it exactly as it lifts Home's (the O1 resolution).
     * `expenses-inr.json`'s ₹19,770 is 30% of ₹65,900 — salary plus ₹900 of freelance income.
     */
    it('lifts the allowance when additional income arrives', async () => {
      const token = await register();

      const before = await expenses(token);
      expect(before.wants.allowance.display).toBe('₹19,500');

      const after = await log(token, { categoryId: 'income', amount: { minor: 90_000, currency: 'INR' } });
      expect(after.wants.allowance.display).toBe('₹19,770');
    });

    it('counts only the three wants categories', async () => {
      const token = await register();

      await log(token, { categoryId: 'groceries', amount: { minor: 86_000, currency: 'INR' } });
      const screen = await log(token, {
        categoryId: 'transport',
        amount: { minor: 44_000, currency: 'INR' },
        optionId: 'metro',
      });

      // Groceries is a *need*, so it does not touch the wants bar.
      expect(screen.wants.used.minor).toBe(44_000);
    });

    it('caps the fill at full and says so when it goes over', async () => {
      const token = await register();

      const screen = await log(token, {
        categoryId: 'entertainment',
        amount: { minor: 2_500_000, currency: 'INR' },
        label: 'A very good night out',
      });

      expect(screen.wants.isOver).toBe(true);
      // An uncapped fill would draw outside its track; `isOver` is what carries the overspend.
      expect(screen.wants.fill).toBe(1);
      expect(Number(screen.wants.percentageLabel.replace('%', ''))).toBeGreaterThan(100);
    });

    it('satisfies the over-budget contract', async () => {
      const token = await register();
      await log(token, {
        categoryId: 'entertainment',
        amount: { minor: 2_140_000, currency: 'INR' },
        label: 'Concert — Coca-Cola Arena',
      });

      const response = await request('GET', '/v1/screens/expenses', token);
      assertMatchesShape(
        fixture('expenses-over-budget.json'),
        await response.json(),
        'GET /v1/screens/expenses',
      );
    });
  });

  // ── Agreement with Home ─────────────────────────────────────────────────────────────────────

  describe('Home and Expenses describe one month', () => {
    /**
     * The D1 regression, from the other direction. Both screens read `monthTotals`, so a figure that
     * appears on both is one computation rather than two — which is what the prototype got wrong.
     */
    it('agree on the month\'s total after a write', async () => {
      const token = await register();

      await request('PUT', '/v1/expenses/fixed/rent', token, { amount: { minor: 300_000, currency: 'INR' } });
      await log(token, { categoryId: 'groceries', amount: { minor: 86_000, currency: 'INR' } });
      const expensesScreen = await log(token, {
        categoryId: 'transport',
        amount: { minor: 44_000, currency: 'INR' },
        optionId: 'metro',
      });

      const homeResponse = await request('GET', '/v1/screens/home', token);
      const home = (await homeResponse.json()) as {
        spending: {
          total: { minor: number; display: string };
          shareOfPayLabel: string;
          isFirstRun: boolean;
          categories: { id: string; amount: { minor: number }; slot: number }[];
        };
      };

      expect(home.spending.total.minor).toBe(expensesScreen.summary.total.minor);
      expect(home.spending.total.display).toBe(expensesScreen.summary.total.display);
      expect(home.spending.isFirstRun).toBe(false);

      // And per category, in Home's own order and slots.
      const homeByCategory = new Map(home.spending.categories.map((c) => [c.id, c.amount.minor]));
      expect(homeByCategory.get('rent')).toBe(300_000);
      expect(homeByCategory.get('groceries')).toBe(86_000);
      expect(homeByCategory.get('transport')).toBe(44_000);
      expect(home.spending.categories.map((c) => c.id)).toEqual([
        'rent', 'groceries', 'transport', 'utilities', 'entertainment', 'other',
      ]);
      expect(home.spending.categories.map((c) => c.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('agree on "% of pay", computed against the one salary', async () => {
      const token = await register();
      await log(token, { categoryId: 'groceries', amount: { minor: 553_900, currency: 'INR' } });

      const home = (await (await request('GET', '/v1/screens/home', token)).json()) as {
        spending: { shareOfPayLabel: string };
      };

      // ₹5,539 of ₹65,000 is 8.5%, which rounds to 9% — the figure `home-inr.json` carries.
      expect(home.spending.shareOfPayLabel).toBe('9% of pay');
    });

    it('agree that a logged expense reduces what was saved', async () => {
      const token = await register();
      const before = (await (await request('GET', '/v1/budget', token)).json()) as { saved: { minor: number } };

      await log(token, { categoryId: 'groceries', amount: { minor: 100_000, currency: 'INR' } });
      const after = (await (await request('GET', '/v1/budget', token)).json()) as { saved: { minor: number } };

      // `saved` is a residual, so spending ₹1,000 reduces it by exactly ₹1,000.
      expect(before.saved.minor - after.saved.minor).toBe(100_000);
    });
  });

  // ── The wants share ───────────────────────────────────────────────────────────────────────────

  /**
   * `PUT /v1/me/budget/wants` — the reader moves the middle figure of their 50/30/20, and the wants bar,
   * its `sharePercent`, and the per-option amounts all come back recomputed from server truth (ADR-0020,
   * invariant 3). A fresh account with no expenses sits in the plain branch, so the allowances are clean
   * percentages of its ₹65,000 income.
   */
  describe('the wants share', () => {
    it('defaults to 30, and offers every share when the goal leaves room for all of them', async () => {
      const screen = await expenses(await register());

      // A fresh account has no needs logged, so ₹13,000 (20%) is reachable at every share — all seven show.
      expect(screen.wants.sharePercent).toBe(30);
      expect(screen.wants.options.map((o) => o.percent)).toEqual([10, 15, 20, 25, 30, 35, 40]);
      // 30% of ₹65,000 = ₹19,500; 40% = ₹26,000. The reader sees these beside the rows.
      expect(screen.wants.options.find((o) => o.percent === 30)?.allowance.minor).toBe(1_950_000);
      expect(screen.wants.options.find((o) => o.percent === 40)?.allowance.minor).toBe(2_600_000);
      // Default allowance is the 30% share.
      expect(screen.wants.allowance.minor).toBe(1_950_000);
    });

    it('drops the shares that would break the savings goal', async () => {
      // Rent of ₹30,000 (needs), plus the ₹13,000 goal, leaves at most ₹22,000 for wants — so 35% (₹22,750)
      // and 40% (₹26,000) are not offered, but the run up to 30% (₹19,500) is.
      const token = await register();
      await request('PUT', '/v1/expenses/fixed/rent', token, {
        amount: { minor: 3_000_000, currency: 'INR' },
      });

      const screen = await expenses(token);
      expect(screen.wants.options.map((o) => o.percent)).toEqual([10, 15, 20, 25, 30]);
    });

    it('persists a chosen share and recomputes the allowance', async () => {
      const token = await register();

      const updated = await screenOf(await request('PUT', '/v1/me/budget/wants', token, { percent: 40 }));
      expect(updated.wants.sharePercent).toBe(40);
      expect(updated.wants.allowance.minor).toBe(2_600_000); // 40% of ₹65,000

      // It survives — a fresh read of the screen carries the same choice.
      const reread = await expenses(token);
      expect(reread.wants.sharePercent).toBe(40);
      expect(reread.wants.allowance.minor).toBe(2_600_000);
    });

    it('refuses a share outside the offered set', async () => {
      const token = await register();
      for (const percent of [33, 5, 45, 0]) {
        const response = await request('PUT', '/v1/me/budget/wants', token, { percent });
        // `VALIDATION_FAILED` is 422 (errors.ts), the same refusal every bad body gets.
        expect(response.status, `percent ${String(percent)}`).toBe(422);
      }
    });
  });
});
