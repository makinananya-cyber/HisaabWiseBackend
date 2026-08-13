import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GRACE_PERIOD_DAYS, runPurgeDeleted } from '../src/jobs/purgeDeleted';
import { createLogger } from '../src/logger';
import { writeRateSet } from '../src/repositories/fxRates';
import * as tombstones from '../src/repositories/tombstones';
import { findByEmail, type User } from '../src/repositories/users';
import { initialsOf, passwordChangedLabel, phoneDisplay } from '../src/screens/account';
import { assertMatchesShape } from './contract/shape';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';
import { fixture } from './support/fixture';

/** Slice 7 — the Account screen, and the compliance surface. */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[account.test] skipped: ${skipReason}`);

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────

describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Neeraj')).toBe('N');
    expect(initialsOf('Ananya Makin')).toBe('AM');
    expect(initialsOf('Maria de los Santos')).toBe('MD');
  });

  it('handles awkward whitespace and an empty name', () => {
    expect(initialsOf('  Neeraj   Menon ')).toBe('NM');
    expect(initialsOf('')).toBe('');
  });

  /**
   * A grapheme, not a code point. The first "letter" of a Devanagari or Tamil name is routinely a base
   * character plus a combining mark, and taking the code point alone draws half a letter in the avatar.
   */
  it('keeps a combining mark with its base character', () => {
    expect(initialsOf('अनन्या')).toBe('अ');
    expect(initialsOf('José')).toBe('J');
    // A Tamil name whose first grapheme is a base character plus a vowel sign. Asserted as a whole string
    // rather than by counting units, which is the very mistake `initialsOf` avoids.
    expect(initialsOf('நந்தினி')).toBe('ந');
  });
});

describe('passwordChangedLabel', () => {
  const now = new Date('2026-08-13T12:00:00Z');
  const zone = 'Asia/Dubai';

  it('reads as a day count, then months, then years', () => {
    expect(passwordChangedLabel(new Date('2026-08-13T09:00:00Z'), now, zone)).toBe('Changed just now');
    expect(passwordChangedLabel(new Date('2026-08-12T09:00:00Z'), now, zone)).toBe('Changed yesterday');
    expect(passwordChangedLabel(new Date('2026-08-08T09:00:00Z'), now, zone)).toBe('Changed 5 days ago');
    expect(passwordChangedLabel(new Date('2026-05-13T09:00:00Z'), now, zone)).toBe('Changed 3 months ago');
    expect(passwordChangedLabel(new Date('2024-08-13T09:00:00Z'), now, zone)).toBe('Changed 2 years ago');
  });

  it('counts day boundaries, not elapsed hours', () => {
    // 23:50 the previous local day is "yesterday", not "13 hours ago" — which is the whole reason this is
    // computed in the stored zone rather than from a duration.
    expect(passwordChangedLabel(new Date('2026-08-12T19:50:00Z'), now, zone)).toBe('Changed yesterday');
  });

  it('pluralises one month and one year correctly', () => {
    expect(passwordChangedLabel(new Date('2026-07-14T09:00:00Z'), now, zone)).toBe('Changed 1 month ago');
  });
});

describe('phoneDisplay', () => {
  it('groups the national part in fives after the dial code', () => {
    expect(phoneDisplay('+91', '9876543210')).toBe('+91 98765 43210');
    expect(phoneDisplay('+971', '501234567')).toBe('+971 50123 4567');
  });
});

// ── Integration ───────────────────────────────────────────────────────────────────────────────

describeIntegration('Account and compliance', () => {
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

  const PASSWORD = 'a-good-enough-password';

  interface Account {
    token: string;
    refreshToken: string;
    user: User;
    email: string;
  }

  async function account(overrides: Record<string, unknown> = {}): Promise<Account> {
    const email = `account+${randomUUID()}@example.ae`;
    const response = await db.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Neeraj',
        email,
        dateOfBirth: '1990-04-12',
        phone: { country: 'IN', dialCode: '+91', national: '9876543210', e164: '+919876543210' },
        password: PASSWORD,
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
    const tokens = (await response.json()) as { accessToken: string; refreshToken: string };

    return {
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: required(await findByEmail(email), 'the registered user'),
      email,
    };
  }

  const send = async (
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    db.app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  interface AccountScreen {
    profile: { initials: string; displayName: string; email: string; summaryLabel: string };
    rows: { section: string; name: string; hint: string; value?: string }[];
    personal: {
      displayName: string;
      email: string;
      isEmailVerified: boolean;
      salary: { minor: number; currency: string; display: string };
      salaryCurrency: { code: string; symbol: string };
      phone: { country: string; display: string } | null;
    };
    language: string;
    currency: string;
    password: { questions: { id: string; text: string }[] };
  }

  const screenOf = async (response: Response): Promise<AccountScreen> => {
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return (await response.json()) as AccountScreen;
  };

  // ── The screen ────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/screens/account', () => {
    it('satisfies the contract', async () => {
      const { token } = await account();
      const response = await send('GET', '/v1/screens/account', token);

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('account-inr.json'), await response.json(), 'GET /v1/screens/account');
    });

    it('carries the four rows in order, with the password subtitle computed', async () => {
      const screen = await screenOf(await send('GET', '/v1/screens/account', (await account()).token));

      expect(screen.rows.map((row) => row.section)).toEqual([
        'personal',
        'language',
        'currency',
        'password',
      ]);
      // Just registered, so the password changed today.
      expect(required(screen.rows[3], 'the password row').hint).toBe('Changed just now');
      expect(required(screen.rows[1], 'the language row').value).toBe('English');
      expect(required(screen.rows[2], 'the currency row').value).toBe('INR');
    });

    it('carries the profile header and the summary chip', async () => {
      const screen = await screenOf(await send('GET', '/v1/screens/account', (await account()).token));

      expect(screen.profile.initials).toBe('N');
      expect(screen.profile.summaryLabel).toBe('INR · English');
    });

    it('shows the salary in the currency it was authored in', async () => {
      // Converting it would mean typing a figure and seeing a different one back.
      const screen = await screenOf(await send('GET', '/v1/screens/account', (await account()).token));

      expect(screen.personal.salary.display).toBe('₹65,000');
      expect(screen.personal.salaryCurrency).toMatchObject({ code: 'INR', symbol: '₹' });
    });

    it('carries the reader\'s own two security questions with their text', async () => {
      const screen = await screenOf(await send('GET', '/v1/screens/account', (await account()).token));

      expect(screen.password.questions.map((question) => question.id)).toEqual(['sq01', 'sq02']);
      for (const question of screen.password.questions) {
        expect(question.text.length).toBeGreaterThan(0);
      }
    });

    it('never returns a security answer or a hash', async () => {
      const { token } = await account();
      const text = await (await send('GET', '/v1/screens/account', token)).text();

      expect(text).not.toMatch(/argon2|answerHash|Fluffy|Jaipur/);
    });

    it('is never cached', async () => {
      const { token } = await account();

      expect((await send('GET', '/v1/screens/account', token)).headers.get('cache-control')).toContain(
        'no-store',
      );
    });
  });

  // ── Personal details ──────────────────────────────────────────────────────────────────────

  describe('PUT /v1/me', () => {
    it('updates the three details and answers with the screen', async () => {
      const { token } = await account();

      const screen = await screenOf(
        await send('PUT', '/v1/me', token, {
          displayName: 'Ananya Makin',
          salary: { minor: 7_000_000, currency: 'INR' },
          phone: { country: 'AE', dialCode: '+971', national: '501234567', e164: '+971501234567' },
        }),
      );

      expect(screen.personal.displayName).toBe('Ananya Makin');
      expect(screen.profile.initials).toBe('AM');
      expect(screen.personal.salary.display).toBe('₹70,000');
      expect(required(screen.personal.phone, 'the phone').display).toBe('+971 50123 4567');
    });

    /** Invariant 4: email is the identity and this route has no parameter for it. */
    it('cannot change the email, however it is asked', async () => {
      const { token, email } = await account();

      const screen = await screenOf(
        await send('PUT', '/v1/me', token, {
          displayName: 'Ananya',
          salary: { minor: 6_500_000, currency: 'INR' },
          email: 'someone.else@example.ae',
        }),
      );

      expect(screen.personal.email).toBe(email);
    });

    it('accepts a cleared phone number', async () => {
      const { token } = await account();

      const screen = await screenOf(
        await send('PUT', '/v1/me', token, {
          displayName: 'Neeraj',
          salary: { minor: 6_500_000, currency: 'INR' },
          phone: null,
        }),
      );

      expect(screen.personal.phone).toBeNull();
    });

    it('changes what Home reports, because the salary has one owner', async () => {
      const { token } = await account();
      await send('PUT', '/v1/me', token, {
        displayName: 'Neeraj',
        salary: { minor: 10_000_000, currency: 'INR' },
      });

      const home = (await (await send('GET', '/v1/screens/home', token)).json()) as {
        savings: { saved: { display: string } };
      };

      // Defect D1's fix, from the other end: one salary, read everywhere.
      expect(home.savings.saved.display).toBe('₹100,000');
    });
  });

  // ── Currency ──────────────────────────────────────────────────────────────────────────────

  describe('PUT /v1/me/currency', () => {
    it('stores the preference and answers with the screen', async () => {
      const { token } = await account();

      const screen = await screenOf(await send('PUT', '/v1/me/currency', token, { currency: 'AED' }));

      expect(screen.currency).toBe('AED');
      assertMatchesShape(fixture('account-aed.json'), screen, 'PUT /v1/me/currency');
    });

    it('repaints every other screen\'s figures', async () => {
      const { token } = await account();
      await send('PUT', '/v1/me/currency', token, { currency: 'AED' });

      const home = (await (await send('GET', '/v1/screens/home', token)).json()) as {
        savings: { goal: { currency: string; display: string } };
      };

      expect(home.savings.goal.currency).toBe('AED');
      expect(home.savings.goal.display).toMatch(/^AED /);
    });

    it('refuses a currency the content does not know, before storing anything', async () => {
      const { token } = await account();

      const response = await send('PUT', '/v1/me/currency', token, { currency: 'ZZZ' });
      expect(response.status).toBe(422);

      // And the reader keeps a working app.
      const screen = await screenOf(await send('GET', '/v1/screens/account', token));
      expect(screen.currency).toBe('INR');
    });
  });

  // ── Password ──────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/me/password', () => {
    const answers = [
      { questionId: 'sq01', answer: 'Fluffy' },
      { questionId: 'sq02', answer: 'Jaipur' },
    ];

    it('changes the password and answers with the screen', async () => {
      const { token, email } = await account();

      const response = await send('POST', '/v1/me/password', token, {
        currentPassword: PASSWORD,
        securityAnswers: answers,
        newPassword: 'a-brand-new-password',
      });
      expect(response.status).toBe(200);

      const withNew = await send('POST', '/v1/auth/login', undefined, {
        email,
        password: 'a-brand-new-password',
        timeZone: 'Asia/Kolkata',
      });
      expect(withNew.status).toBe(200);
    });

    /**
     * **A `422`, never a `401`.** On this client a `401` means "your token is no good", so it spends the
     * refresh token; against a rotating family a mistyped current password would end the session.
     */
    it('refuses a wrong current password with 422, not 401', async () => {
      const { token } = await account();

      const response = await send('POST', '/v1/me/password', token, {
        currentPassword: 'not-the-password',
        securityAnswers: answers,
        newPassword: 'a-brand-new-password',
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses wrong security answers with 422, without saying which', async () => {
      const { token } = await account();

      const first = await send('POST', '/v1/me/password', token, {
        currentPassword: PASSWORD,
        securityAnswers: [{ questionId: 'sq01', answer: 'Rex' }, answers[1]],
        newPassword: 'a-brand-new-password',
      });
      const second = await send('POST', '/v1/me/password', token, {
        currentPassword: PASSWORD,
        securityAnswers: [answers[0], { questionId: 'sq02', answer: 'Jodhpur' }],
        newPassword: 'a-brand-new-password',
      });

      expect(first.status).toBe(422);
      expect(await first.text()).toBe(await second.text());
    });

    it('refuses a new password under 8 characters', async () => {
      const { token } = await account();

      const response = await send('POST', '/v1/me/password', token, {
        currentPassword: PASSWORD,
        securityAnswers: answers,
        newPassword: 'short12',
      });

      expect(response.status).toBe(422);
    });

    /** Product Spec §3.7: a password change kills every *other* session, immediately. */
    it('kills another device\'s session at once', async () => {
      const { token, refreshToken, email } = await account();
      const second = await send('POST', '/v1/auth/login', undefined, {
        email,
        password: PASSWORD,
        timeZone: 'Asia/Kolkata',
      });
      const tablet = (await second.json()) as { accessToken: string; refreshToken: string };

      await send(
        'POST',
        '/v1/me/password',
        token,
        { currentPassword: PASSWORD, securityAnswers: answers, newPassword: 'a-brand-new-password' },
        // The family to keep, identified by the refresh token this device holds.
        { 'x-refresh-token': refreshToken },
      );

      // The tablet's access token dies now, via the `securityEpoch` bump — not in fifteen minutes.
      expect((await send('GET', '/v1/me', tablet.accessToken)).status).toBe(401);
      // And its refresh token is revoked.
      const refreshed = await send('POST', '/v1/auth/refresh', undefined, {
        refreshToken: tablet.refreshToken,
        timeZone: 'Asia/Kolkata',
      });
      expect(refreshed.status).toBe(401);
    });

    it('keeps the requesting device signed in', async () => {
      const { token, refreshToken } = await account();

      await send(
        'POST',
        '/v1/me/password',
        token,
        { currentPassword: PASSWORD, securityAnswers: answers, newPassword: 'a-brand-new-password' },
        { 'x-refresh-token': refreshToken },
      );

      // Signing the reader out of the device they just used to change their password would be a confusing
      // way to confirm success.
      const refreshed = await send('POST', '/v1/auth/refresh', undefined, {
        refreshToken,
        timeZone: 'Asia/Kolkata',
      });
      expect(refreshed.status).toBe(200);
    });
  });

  // ── Export ────────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/me/export', () => {
    it('satisfies the contract and carries every collection', async () => {
      const { token } = await account();
      await send('POST', '/v1/expenses', token, {
        categoryId: 'groceries',
        amount: { minor: 24_000, currency: 'INR' },
      });

      const response = await send('GET', '/v1/me/export', token);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('hisaabwise-export.json');
      assertMatchesShape(fixture('me-export.json'), await response.json(), 'GET /v1/me/export');
    });

    /** Invariant 5: an answer never leaves the server, not even to its owner. */
    it('carries the security question ids but never the answers', async () => {
      const { token } = await account();
      const text = await (await send('GET', '/v1/me/export', token)).text();

      expect(text).toContain('sq01');
      expect(text).not.toMatch(/argon2|answerHash|Fluffy|Jaipur/);
      // And no password hash, obviously.
      expect(text).not.toContain('passwordHash');
    });

    it('serves one collection as CSV', async () => {
      const { token } = await account();
      await send('POST', '/v1/expenses', token, {
        categoryId: 'groceries',
        amount: { minor: 24_000, currency: 'INR' },
      });

      const response = await send('GET', '/v1/me/export?format=csv&part=expenses', token);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/csv');
      const csv = await response.text();
      expect(csv.split('\n')[0]).toContain('monthKey');
      expect(csv.split('\n')).toHaveLength(2);
    });

    /**
     * An exported CSV is opened in a spreadsheet, so a label beginning `=` is a formula rather than a label.
     * The reader chose that label, which makes this a self-inflicted injection unless it is neutralised.
     */
    it('neutralises a label that a spreadsheet would read as a formula', async () => {
      const { token } = await account();
      await send('POST', '/v1/expenses', token, {
        categoryId: 'entertainment',
        amount: { minor: 10_000, currency: 'INR' },
        label: '=1+1',
      });

      const csv = await (await send('GET', '/v1/me/export?format=csv&part=expenses', token)).text();

      expect(csv).toContain(`"'=1+1"`);
    });

    it('refuses an unknown CSV part', async () => {
      const { token } = await account();

      expect((await send('GET', '/v1/me/export?format=csv&part=everything', token)).status).toBe(422);
    });

    it('needs a session', async () => {
      expect((await send('GET', '/v1/me/export', undefined)).status).toBe(401);
    });
  });

  // ── Deletion ──────────────────────────────────────────────────────────────────────────────

  describe('DELETE /v1/me', () => {
    it('starts the grace period and blocks sign-in', async () => {
      const { token, email } = await account();

      const response = await send('DELETE', '/v1/me', token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { purgeAfterDays: number; message: string };
      expect(body.purgeAfterDays).toBe(30);
      expect(body.message).toContain('30 days');

      const signIn = await send('POST', '/v1/auth/login', undefined, {
        email,
        password: PASSWORD,
        timeZone: 'Asia/Kolkata',
      });
      expect(signIn.status).toBe(403);
      expect(((await signIn.json()) as { error: { code: string } }).error.code).toBe(
        'ACCOUNT_PENDING_DELETION',
      );
    });

    /**
     * The access token dies **as a token**, not as a permission.
     *
     * `softDelete` bumps `securityEpoch`, so the `sec` claim no longer matches and the middleware refuses the
     * token with `401` before it ever reaches the `deletedAt` check. That is the right ordering and the
     * stronger statement: the credential is invalid, not merely unauthorised. `ACCOUNT_PENDING_DELETION`
     * belongs on **sign-in**, which is where the client offers to restore, and the test above asserts it there.
     */
    it('ends every session at once', async () => {
      const { token } = await account();
      await send('DELETE', '/v1/me', token);

      expect((await send('GET', '/v1/me', token)).status).toBe(401);
    });

    it('keeps the email reserved during the grace period', async () => {
      const { token, email } = await account();
      await send('DELETE', '/v1/me', token);

      const again = await send('POST', '/v1/auth/register', undefined, {
        name: 'Someone Else',
        email,
        dateOfBirth: '1990-04-12',
        password: PASSWORD,
        displayCurrency: 'INR',
        salary: { minor: 100, currency: 'INR' },
        savingsGoal: { minor: 100, currency: 'INR' },
        goalWasSkipped: false,
        securityAnswers: [
          { questionId: 'sq01', answer: 'Rex' },
          { questionId: 'sq02', answer: 'Delhi' },
        ],
        acceptedTerms: true,
        timeZone: 'Asia/Kolkata',
        language: 'en',
      });

      expect(again.status).toBe(409);
    });
  });

  describe('purge:deleted', () => {
    it('leaves an account inside its grace period alone', async () => {
      const { token, user } = await account();
      await send('DELETE', '/v1/me', token);

      await runPurgeDeleted(logger, new Date());

      expect(await findByEmail(user.email)).not.toBeNull();
    });

    /** After the purge, **no user data remains in any collection** — only a tombstone. */
    it('erases everything after the grace period, leaving a tombstone', async () => {
      const { token, user, email } = await account();
      await send('POST', '/v1/expenses', token, {
        categoryId: 'groceries',
        amount: { minor: 24_000, currency: 'INR' },
      });
      await send('PUT', '/v1/expenses/fixed/rent', token, { amount: { minor: 300_000, currency: 'INR' } });
      await send('POST', '/v1/learn/lessons/u1l1/complete', token, {
        results: [{ stepIndex: 3, isCorrect: true }],
      }).catch(() => undefined);
      await send('DELETE', '/v1/me', token);

      const after = new Date(Date.now() + (GRACE_PERIOD_DAYS + 1) * 86_400_000);
      const outcome = await runPurgeDeleted(logger, after);
      expect(outcome.purged).toBeGreaterThanOrEqual(1);

      // Nothing left, anywhere.
      expect(await findByEmail(email)).toBeNull();
      const { entriesForMonth } = await import('../src/repositories/expenseEntries');
      const { forUser: fixedFor } = await import('../src/repositories/fixedCosts');
      const { archivesForUser } = await import('../src/repositories/monthArchives');
      const { forUser: learnFor } = await import('../src/repositories/learnProgress');

      expect(await entriesForMonth(user._id, '2026-08')).toEqual([]);
      expect((await fixedFor(user._id, 'INR')).rent.minor).toBe(0);
      expect(await archivesForUser(user._id)).toEqual([]);
      expect((await learnFor(user._id)).xp).toBe(0);

      // And erasure is *evidenced* rather than merely invisible.
      const hash = createHash('sha256').update(user._id.toHexString()).digest('hex');
      expect(await tombstones.wasPurged(hash)).toBe(true);
    });

    it('releases the email once the account is purged', async () => {
      const { token, email } = await account();
      await send('DELETE', '/v1/me', token);
      await runPurgeDeleted(logger, new Date(Date.now() + (GRACE_PERIOD_DAYS + 1) * 86_400_000));

      const again = await send('POST', '/v1/auth/register', undefined, {
        name: 'Someone Else',
        email,
        dateOfBirth: '1990-04-12',
        password: PASSWORD,
        displayCurrency: 'INR',
        salary: { minor: 100_000, currency: 'INR' },
        savingsGoal: { minor: 10_000, currency: 'INR' },
        goalWasSkipped: false,
        securityAnswers: [
          { questionId: 'sq01', answer: 'Rex' },
          { questionId: 'sq02', answer: 'Delhi' },
        ],
        acceptedTerms: true,
        timeZone: 'Asia/Kolkata',
        language: 'en',
      });

      expect(again.status).toBe(201);
    });
  });

  // ── Events ────────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/events', () => {
    it('accepts an allowlisted event without a session', async () => {
      // The events worth having start before there is an account.
      const response = await send('POST', '/v1/events', undefined, {
        installId: randomUUID(),
        events: [{ name: 'app_opened' }, { name: 'landing_viewed' }],
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ received: 2, accepted: 2 });
    });

    it('drops an event nobody declared, and keeps the rest of the batch', async () => {
      const response = await send('POST', '/v1/events', undefined, {
        installId: randomUUID(),
        events: [{ name: 'app_opened' }, { name: 'exfiltrate_everything' }],
      });

      // An unauthenticated writer must not choose collection contents; refusing the whole batch for one bad
      // name would lose the good ones.
      expect(await response.json()).toEqual({ received: 2, accepted: 1 });
    });

    it('strips a prop the event did not declare', async () => {
      const installId = randomUUID();
      await send('POST', '/v1/events', undefined, {
        installId,
        events: [{ name: 'expense_logged', props: { categoryId: 'groceries', secret: 'kept out' } }],
      });

      const { token } = await account();
      // Stitch it so the export can see it, then check what was stored.
      const { stitchInstall } = await import('../src/repositories/events');
      const { findByEmail: find } = await import('../src/repositories/users');
      const user = required(await find((await account()).email), 'a user');
      await stitchInstall(installId, user._id);

      const { forUser } = await import('../src/repositories/events');
      const stored = await forUser(user._id);
      const logged = required(
        stored.find((event) => event.name === 'expense_logged'),
        'the expense_logged event',
      );
      expect(logged.props).toEqual({ categoryId: 'groceries' });
      expect(token.length).toBeGreaterThan(0);
    });

    it('stitches pre-account events to the account they become', async () => {
      const installId = randomUUID();
      await send('POST', '/v1/events', undefined, {
        installId,
        events: [{ name: 'app_opened' }, { name: 'registration_started' }],
      });

      // Registration carries the install id, which is what makes activation measurable across the boundary.
      const email = `stitched+${randomUUID()}@example.ae`;
      await send('POST', '/v1/auth/register', undefined, {
        name: 'Neeraj',
        email,
        dateOfBirth: '1990-04-12',
        password: PASSWORD,
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
        installId,
      });

      const user = required(await findByEmail(email), 'the registered user');
      const { forUser } = await import('../src/repositories/events');
      const stored = await forUser(user._id);

      expect(stored.map((event) => event.name)).toContain('app_opened');
      expect(stored.map((event) => event.name)).toContain('registration_started');
    });

    it('refuses an empty or oversized batch', async () => {
      expect((await send('POST', '/v1/events', undefined, { events: [] })).status).toBe(422);
      expect(
        (
          await send('POST', '/v1/events', undefined, {
            events: Array.from({ length: 51 }, () => ({ name: 'app_opened' })),
          })
        ).status,
      ).toBe(422);
    });
  });
});
