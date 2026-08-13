import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertMatchesAnyShape, assertMatchesShape } from './contract/shape';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';
import { fixture } from './support/fixture';

/**
 * Slice 3's integration test — Home, `GET /v1/budget`, and `GET /v1/fx/rates` end to end.
 *
 * Two properties this suite exists to hold:
 *
 *  1. **Home renders from one request with no client-side arithmetic** (ADR-0020) — every figure, label,
 *     share, slot and verdict arrives computed.
 *  2. **The D1 regression holds.** Salary has exactly one owner, so an INR salary shows identically
 *     everywhere and "% of pay" is computed against it. The prototype hardcoded `salary: 8000` on Home
 *     and defaulted to ₹65,000 on Account, which is what made the same user's percentages disagree.
 */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[home.test] skipped: ${skipReason}`);

describeIntegration('Home and the budget engine', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await setupDatabase();
    await db.clear();
    await seedRates();
  });

  afterAll(async () => {
    await db.drop();
  });

  /**
   * A rate set, so a reader whose display currency differs from their authored one can be served.
   *
   * Written through the repository rather than by hand, so the "every listed code must be present" rule
   * is exercised rather than bypassed.
   */
  async function seedRates(): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const seed = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', 'content', 'fx-seed.json'), 'utf8'),
    ) as { rates: Record<string, number> };

    const { writeRateSet } = await import('../src/repositories/fxRates');
    const { getContent } = await import('../src/content');
    await writeRateSet(
      { dateKey: '2026-08-13', rates: seed.rates },
      getContent().currencies.value.currencies.map((currency) => currency.code),
      new Date(),
    );
  }

  const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Ananya',
    email: `ananya+${randomUUID()}@example.ae`,
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
  });

  async function register(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await db.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registration(overrides)),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { accessToken } = (await response.json()) as { accessToken: string };
    return accessToken;
  }

  const read = async (path: string, token: string): Promise<Response> =>
    db.app.request(path, { headers: { Authorization: `Bearer ${token}` } });

  interface HomeBody {
    greeting: string;
    name: string;
    dateLabel: string;
    monthLabel: string;
    spending: {
      total: { minor: number; currency: string; display: string };
      shareOfPayLabel: string;
      isFirstRun: boolean;
      categories: unknown[];
    };
    savings: {
      saved: { minor: number; display: string };
      goal: { minor: number; currency: string; display: string };
      zeroLabel: string;
      percentageLabel: string;
      position: number;
      verdict: string;
      remaining: { minor: number } | null;
    };
    tip: { id: string; dayKey: string; text: string; currencyToken: string };
    learning: { streak: number; summary: string; nextLesson: string };
    articles: { id: string; short: string; icon: string; accent: number }[];
  }

  const home = async (token: string): Promise<HomeBody> => {
    const response = await read('/v1/screens/home', token);
    expect(response.status).toBe(200);
    return (await response.json()) as HomeBody;
  };

  // ── The contract ────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/screens/home', () => {
    /**
     * A newly registered user has no expenses and no XP, which is not a stub — it is the state every real
     * user starts in.
     *
     * Checked against **both** Home fixtures, because between them they document that
     * `savings.remaining` is `Money?`: `home-first-run.json` carries an amount there and `home-inr.json`
     * carries `null`. A fresh account whose residual already exceeds its goal legitimately answers `null`.
     */
    it('satisfies the Home contract for a new account', async () => {
      const token = await register();
      const response = await read('/v1/screens/home', token);

      expect(response.status).toBe(200);
      assertMatchesAnyShape(
        [
          { name: 'home-first-run.json', value: fixture('home-first-run.json') },
          { name: 'home-inr.json', value: fixture('home-inr.json') },
        ],
        await response.json(),
        'GET /v1/screens/home',
      );
    });

    it('is never cached', async () => {
      const token = await register();
      const response = await read('/v1/screens/home', token);

      // A HIT here is one person's salary served to another (invariant 8).
      expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('needs a session', async () => {
      expect((await db.app.request('/v1/screens/home')).status).toBe(401);
    });
  });

  // ── The D1 regression ───────────────────────────────────────────────────────────────────────

  describe('the salary has one owner', () => {
    /**
     * Defect D1, as a test. Home hardcoded `salary: 8000` in the prototype while Account defaulted to
     * ₹65,000, so the same user's "% of pay" was computed against two different salaries. Here the figure
     * on the screen and the figure "% of pay" divides by are the same read of the same field.
     */
    it('reads the registered salary and computes % of pay against it', async () => {
      const token = await register({
        salary: { minor: 6_500_000, currency: 'INR' },
        savingsGoal: { minor: 1_300_000, currency: 'INR' },
      });

      const body = await home(token);

      // Nothing spent yet, so 0% of pay — and crucially not `NaN%`, which is what dividing by a missing
      // salary produces.
      expect(body.spending.shareOfPayLabel).toBe('0% of pay');
      expect(body.savings.saved.display).toBe('₹65,000');
      expect(body.savings.goal.display).toBe('₹13,000');
      expect(body.savings.goal.currency).toBe('INR');
    });

    it('shows an INR salary in rupees, not in the market default', async () => {
      const token = await register({
        displayCurrency: 'INR',
        salary: { minor: 6_500_000, currency: 'INR' },
        savingsGoal: { minor: 1_300_000, currency: 'INR' },
      });

      const body = await home(token);

      expect(body.savings.goal.display).toBe('₹13,000');
      expect(body.savings.zeroLabel).toBe('₹0');
      expect(body.tip.currencyToken).toBe('₹');
    });

    it('shows an AED salary in dirhams, with the code and a space', async () => {
      const token = await register({
        displayCurrency: 'AED',
        salary: { minor: 800_000, currency: 'AED' },
        savingsGoal: { minor: 160_000, currency: 'AED' },
        timeZone: 'Asia/Dubai',
      });

      const body = await home(token);

      expect(body.savings.goal.display).toBe('AED 1,600');
      expect(body.savings.zeroLabel).toBe('AED 0');
      // The gap travels with the token, so "{c}6,400" resolves to "AED 6,400" and not "AED6,400".
      expect(body.tip.currencyToken).toBe('AED ');
    });

    /**
     * Invariant 7's sibling on the live month: a display currency is a **read-time** concern. Changing it
     * converts the figures and migrates nothing.
     */
    it('converts an authored salary into a different display currency', async () => {
      const token = await register({
        displayCurrency: 'AED',
        salary: { minor: 6_500_000, currency: 'INR' },
        savingsGoal: { minor: 1_300_000, currency: 'INR' },
      });

      const body = await home(token);

      // ₹13,000 at 84.2 INR and 3.6725 AED per USD is about AED 567.
      expect(body.savings.goal.currency).toBe('AED');
      expect(body.savings.goal.display).toMatch(/^AED /);
      expect(body.savings.goal.minor / 100).toBeCloseTo((13_000 * 3.6725) / 84.2, 0);
    });
  });

  // ── Everything arrives computed ─────────────────────────────────────────────────────────────

  describe('what the client does not have to work out', () => {
    it('carries the greeting, the date and the month, in the reader\'s timezone', async () => {
      const token = await register({ timeZone: 'Asia/Kolkata' });

      const body = await home(token);

      expect(['Good morning', 'Good afternoon', 'Good evening']).toContain(body.greeting);
      // "Tuesday, 11 August" — the client prints it verbatim and owns no calendar.
      expect(body.dateLabel).toMatch(/^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+$/);
      expect(body.monthLabel).toMatch(/^[A-Z][a-z]+$/);
    });

    /**
     * **`saved` is a residual, and on a month with nothing logged the residual is the whole salary.**
     *
     * Product Spec §4.2 defines `saved = max(0, income − needs − wantsSpent)` and carves out no first-run
     * case, so a fresh ₹65,000 account against a ₹13,000 goal reads 500% — the meter is a *projection* of
     * "what you keep if you stop here", not a record of what was transferred. The engine has no
     * special case, deliberately: a first-run branch inside it is exactly the second code path that
     * produced defect D1.
     *
     * `home-first-run.json` shows `saved: 0` instead. That fixture's *figures* are not contract
     * (ADR-0017), but the divergence is a real product question and is flagged as one.
     */
    it('carries the savings meter already thresholded, from the residual', async () => {
      const token = await register();

      const body = await home(token);

      expect(body.savings.saved.minor).toBe(6_500_000);
      expect(body.savings.percentageLabel).toBe('500% of goal');
      expect(body.savings.position).toBe(1);
      expect(body.savings.verdict).toBe('met');
      // Nothing left to ask for, so the field is null rather than a zero.
      expect(body.savings.remaining).toBeNull();
    });

    it('reports what is left when the goal is above the residual', async () => {
      const token = await register({
        salary: { minor: 1_000_000, currency: 'INR' },
        savingsGoal: { minor: 5_000_000, currency: 'INR' },
      });

      const body = await home(token);

      expect(body.savings.verdict).toBe('low');
      expect(required(body.savings.remaining, 'the remaining amount').minor).toBe(4_000_000);
      expect(body.savings.percentageLabel).toBe('20% of goal');
    });

    it('says whether this is a first run rather than leaving the client to infer it from a zero', async () => {
      const token = await register();

      const body = await home(token);

      expect(body.spending.isFirstRun).toBe(true);
      // An empty donut is a different screen — copy rather than a zero-value chart — so it carries no
      // segments at all.
      expect(body.spending.categories).toEqual([]);
      expect(body.spending.total.minor).toBe(0);
    });

    it('picks a tip for the reader\'s local day, stably', async () => {
      const token = await register({ timeZone: 'Asia/Kolkata' });

      const first = await home(token);
      const second = await home(token);

      // A tip that changed on every request would make the card flicker on each foreground.
      expect(second.tip.id).toBe(first.tip.id);
      expect(first.tip.id).toMatch(/^tip-\d{2}$/);
      expect(first.tip.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The **raw** text with its tokens intact, so "Show me another" can cycle the pool in memory.
      expect(first.tip.text.length).toBeGreaterThan(0);
    });

    it('gives two readers different tips on the same day', async () => {
      // Otherwise the feature reads as a broadcast rather than a suggestion.
      const tips = new Set<string>();
      for (let reader = 0; reader < 6; reader++) {
        tips.add((await home(await register())).tip.id);
      }

      expect(tips.size).toBeGreaterThan(1);
    });

    it('carries the first-run learning summary', async () => {
      const token = await register();

      const body = await home(token);

      expect(body.learning.streak).toBe(0);
      expect(body.learning.summary).toContain('No XP yet');
      expect(body.learning.nextLesson).toBe('');
    });

    /**
     * The teasers come from the content, so their ids are the ones `/v1/content/articles/:id` serves.
     * `home-inr.json` carries `remittance` and `credit`, which the content does not have — the fixture was
     * written against a doc comment rather than against the design. Serving the content's ids is what makes
     * the tap-through work, and the shape harness asserts types rather than values for this reason.
     */
    it('carries article teasers whose ids resolve to real articles', async () => {
      const token = await register();

      const body = await home(token);

      expect(body.articles.map((article) => article.id)).toEqual(['scams', 'remit', 'debt']);
      for (const teaser of body.articles) {
        expect(teaser.accent).toBeGreaterThanOrEqual(1);
        expect(teaser.accent).toBeLessThanOrEqual(5);

        const article = await db.app.request(`/v1/content/articles/${teaser.id}`);
        expect(article.status, teaser.id).toBe(200);
      }
    });
  });

  // ── The budget endpoint ─────────────────────────────────────────────────────────────────────

  describe('GET /v1/budget', () => {
    it('satisfies the contract for an INR reader', async () => {
      const token = await register();
      const response = await read('/v1/budget', token);

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('budget-inr.json'), await response.json(), 'GET /v1/budget');
    });

    it('satisfies the contract for an AED reader', async () => {
      const token = await register({
        displayCurrency: 'AED',
        salary: { minor: 800_000, currency: 'AED' },
        savingsGoal: { minor: 160_000, currency: 'AED' },
        timeZone: 'Asia/Dubai',
      });
      const response = await read('/v1/budget', token);

      assertMatchesShape(fixture('budget-aed.json'), await response.json(), 'GET /v1/budget');
    });

    it('runs the plain branch on a salary with no needs against it', async () => {
      const token = await register();
      const body = (await (await read('/v1/budget', token)).json()) as {
        income: { display: string };
        wantsAllowance: { minor: number };
        savingsAllowance: { minor: number };
        adapted: boolean;
        saved: { minor: number };
        overspent: boolean;
        verdict: string;
        month: string;
        currency: string;
      };

      expect(body.income.display).toBe('₹65,000');
      expect(body.wantsAllowance.minor).toBe(1_950_000);
      expect(body.currency).toBe('INR');
      expect(body.savingsAllowance.minor).toBe(1_300_000);
      expect(body.adapted).toBe(false);
      // Nothing spent, so the whole income is the residual and the goal is comfortably met.
      expect(body.saved.minor).toBe(6_500_000);
      expect(body.overspent).toBe(false);
      expect(body.verdict).toBe('hit');
      expect(body.month).toMatch(/^\d{4}-\d{2}$/);
      expect(body.currency).toBe('INR');
    });

    /**
     * `budget-drifted.json` is a **negative** fixture: a payload with a blank `display` that the client must
     * refuse (iOS ADR-0027). This asserts the server cannot produce one.
     */
    it('never emits a blank display string, which the client would refuse', async () => {
      const token = await register();
      const text = await (await read('/v1/budget', token)).text();

      expect(text).not.toMatch(/"display"\s*:\s*""/);
    });

    it('is never cached', async () => {
      const token = await register();

      expect((await read('/v1/budget', token)).headers.get('cache-control')).toContain('no-store');
    });
  });

  // ── FX ──────────────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/fx/rates', () => {
    it('serves the newest set, cacheably, with every currency in it', async () => {
      const response = await db.app.request('/v1/fx/rates');

      expect(response.status).toBe(200);
      const body = (await response.json()) as { dateKey: string; base: string; rates: Record<string, number> };
      expect(body.base).toBe('USD');
      expect(body.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(body.rates)).toHaveLength(160);
      expect(body.rates.USD).toBe(1);
      // Cacheable, because it is the same rates for everybody (invariant 8).
      expect(response.headers.get('cache-control')).toContain('public');
    });

    it('refuses to write an incomplete set', async () => {
      const { writeRateSet } = await import('../src/repositories/fxRates');
      const { getContent } = await import('../src/content');

      // A partial set silently breaks the display currency of whoever picked a missing code, which is the
      // hardcoded fallback Product Spec §4.1 forbids outright.
      await expect(
        writeRateSet(
          { dateKey: '2026-08-14', rates: { USD: 1, AED: 3.6725 } },
          getContent().currencies.value.currencies.map((currency) => currency.code),
          new Date(),
        ),
      ).rejects.toThrow(/an incomplete rate set is not written/);
    });

    it('is idempotent for a day it already has', async () => {
      const { writeRateSet, countRateSets } = await import('../src/repositories/fxRates');
      const { getContent } = await import('../src/content');
      const codes = getContent().currencies.value.currencies.map((currency) => currency.code);
      const rates = Object.fromEntries(codes.map((code) => [code, 1]));

      const before = await countRateSets();
      await writeRateSet({ dateKey: '2026-09-01', rates }, codes, new Date());
      const second = await writeRateSet({ dateKey: '2026-09-01', rates }, codes, new Date());

      // A set is a fact about a date, and two runs agree — so the second write is a no-op rather than a
      // second version of one day's truth.
      expect(second).toBeUndefined();
      expect(await countRateSets()).toBe(before + 1);
    });
  });
});
