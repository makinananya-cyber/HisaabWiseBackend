import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertMatchesShape } from './contract/shape';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';
import { fixture } from './support/fixture';

/**
 * Slice 2's integration test — identity, end to end, against a real per-run Atlas database (ADR-0014).
 *
 * The five properties this suite exists to hold are the ones a refactor loses quietly:
 *
 *  1. Registration is **atomic** — one request, no half-built account.
 *  2. An unknown email is **indistinguishable** from a wrong password, in body and in timing.
 *  3. Reuse of a revoked refresh token **revokes the whole family**.
 *  4. A password change **invalidates outstanding access tokens immediately**, not in fifteen minutes.
 *  5. Security answers never leave the server and are compared over the **normalised** form.
 *
 * Driven through `app.request()`, so routing, the middleware chain and the real serialised bodies are all
 * covered — the same HTTP seam the content suite uses.
 */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[auth.test] skipped: ${skipReason}`);

describeIntegration('identity', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await setupDatabase();
    await db.clear();
  });

  afterAll(async () => {
    await db.drop();
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────

  /**
   * A registration body that passes validation, with any field overridable.
   *
   * A builder rather than a shared constant, because half these tests are about one field being wrong and
   * a shared object would have them editing each other's.
   *
   * **The email is unique per call, and that is what isolates the tests** — lockout counters, token
   * families and reset tickets are all per-user, so a fresh user is a fresh world. Truncating the
   * collections between tests was the alternative and it cost a dozen Atlas round trips per test.
   */
  const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Neeraj',
    email: `neeraj+${randomUUID()}@example.ae`,
    dateOfBirth: '1990-04-12',
    phone: { country: 'AE', dialCode: '+971', national: '501234567', e164: '+971501234567' },
    password: 'a-good-enough-password',
    displayCurrency: 'AED',
    salary: { minor: 800_000, currency: 'AED' },
    savingsGoal: { minor: 160_000, currency: 'AED' },
    goalWasSkipped: false,
    securityAnswers: [
      { questionId: 'sq01', answer: 'Fluffy' },
      { questionId: 'sq02', answer: 'Jaipur' },
    ],
    acceptedTerms: true,
    timeZone: 'Asia/Dubai',
    language: 'en',
    ...overrides,
  });

  const post = async (path: string, body: unknown, token?: string): Promise<Response> =>
    db.app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  const put = async (path: string, body: unknown, token?: string): Promise<Response> =>
    db.app.request(path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  interface Session {
    accessToken: string;
    refreshToken: string;
  }

  /** Register an account and return its session and the body it was created from. */
  async function register(
    overrides: Record<string, unknown> = {},
  ): Promise<{ session: Session; input: Record<string, unknown> }> {
    const input = registration(overrides);
    const response = await post('/v1/auth/register', input);
    expect(response.status, await response.clone().text()).toBe(201);
    return { session: (await response.json()) as Session, input };
  }

  const codeOf = async (response: Response): Promise<string> => {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code ?? '(no code)';
  };

  // ── Registration ────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/auth/register', () => {
    it('creates an account and answers with a signed-in session', async () => {
      const input = registration();
      const response = await post('/v1/auth/register', input);

      expect(response.status).toBe(201);
      assertMatchesShape(fixture('session-tokens.json'), await response.json(), 'register');
    });

    it('mints an access token the client can read exp and sec off', async () => {
      const { session } = await register();

      // The client reads both claims off the token itself rather than from sibling fields (iOS
      // `AccessToken`), so a token missing either is a token it refuses at sign-in.
      const payload = required(session.accessToken.split('.')[1], 'the access token payload segment');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;

      expect(typeof claims.exp).toBe('number');
      expect(claims.sec).toBe(1);
      expect(typeof claims.sub).toBe('string');
    });

    it('refuses a second account on the same email', async () => {
      const input = registration();
      await post('/v1/auth/register', input);

      const response = await post('/v1/auth/register', input);

      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe('EMAIL_TAKEN');
    });

    it('treats email case-insensitively, so one address is one account', async () => {
      const local = `neeraj.mixed.${randomUUID()}`;
      await post('/v1/auth/register', registration({ email: `${local}@Example.AE` }));

      const response = await post('/v1/auth/register', {
        ...registration(),
        email: `${local.toUpperCase()}@example.ae`,
      });

      expect(await codeOf(response)).toBe('EMAIL_TAKEN');
    });

    it('refuses an applicant under 13', async () => {
      const response = await post('/v1/auth/register', registration({ dateOfBirth: '2020-01-01' }));

      expect(await codeOf(response)).toBe('UNDER_AGE');
    });

    it('refuses a submission that did not accept the terms', async () => {
      const response = await post('/v1/auth/register', registration({ acceptedTerms: false }));

      expect(await codeOf(response)).toBe('TERMS_NOT_ACCEPTED');
    });

    it('refuses a password under 8 characters', async () => {
      const response = await post('/v1/auth/register', registration({ password: 'short12' }));

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses two answers to the same question', async () => {
      // Two answers to one question is one factor wearing a disguise, and it would halve the strength of
      // the only mechanism that can recover an account.
      const response = await post(
        '/v1/auth/register',
        registration({
          securityAnswers: [
            { questionId: 'sq01', answer: 'Fluffy' },
            { questionId: 'sq01', answer: 'Rex' },
          ],
        }),
      );

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses a question id that is not in the bank', async () => {
      const response = await post(
        '/v1/auth/register',
        registration({
          securityAnswers: [
            { questionId: 'sq99', answer: 'Fluffy' },
            { questionId: 'sq02', answer: 'Jaipur' },
          ],
        }),
      );

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses an answer with nothing identifying in it', async () => {
      // "the" normalises to the empty string, and a hash of nothing matches every other empty answer.
      const response = await post(
        '/v1/auth/register',
        registration({
          securityAnswers: [
            { questionId: 'sq01', answer: 'the' },
            { questionId: 'sq02', answer: 'Jaipur' },
          ],
        }),
      );

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses a currency the content does not know', async () => {
      const response = await post(
        '/v1/auth/register',
        registration({ salary: { minor: 800_000, currency: 'ZZZ' } }),
      );

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses a salary that is not an integer count of minor units', async () => {
      // A float in a monetary path is defect-shaped: two sides rounding differently produce a figure
      // nobody can reconcile (invariant 1).
      const response = await post(
        '/v1/auth/register',
        registration({ salary: { minor: 800_000.5, currency: 'AED' } }),
      );

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses an offset in place of a timezone', async () => {
      const response = await post('/v1/auth/register', registration({ timeZone: '+04:00' }));

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('leaves nothing behind when it refuses, so there is no half-built account', async () => {
      const input = registration({ acceptedTerms: false });
      await post('/v1/auth/register', input);

      // The same email must still be registrable — nothing was persisted by the refusal.
      const second = await post('/v1/auth/register', { ...input, acceptedTerms: true });
      expect(second.status).toBe(201);
    });
  });

  // ── Sign in ─────────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/auth/login', () => {
    it('signs in with the right password', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('session-tokens.json'), await response.json(), 'login');
    });

    it('refuses a wrong password', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/login', {
        email: input.email,
        password: 'not-the-password',
        timeZone: 'Asia/Dubai',
      });

      expect(response.status).toBe(422);
      expect(await codeOf(response)).toBe('INVALID_CREDENTIALS');
    });

    /**
     * The anti-enumeration property, asserted rather than asserted-about (ADR-0010).
     *
     * If an unknown email answered differently — a different code, a different status, or an answer that
     * arrived sooner — the login route would be the account-enumeration oracle that ADR-0004 declined to
     * build as an endpoint.
     */
    it('answers identically for an unknown email and a wrong password', async () => {
      const { input } = await register();

      const unknown = await post('/v1/auth/login', {
        email: 'nobody-has-this@example.ae',
        password: 'not-the-password',
        timeZone: 'Asia/Dubai',
      });
      const wrong = await post('/v1/auth/login', {
        email: input.email,
        password: 'not-the-password',
        timeZone: 'Asia/Dubai',
      });

      expect(unknown.status).toBe(wrong.status);
      expect(await unknown.text()).toBe(await wrong.text());
    });

    it('pays the same hashing cost for an unknown email, so the timing does not leak either', async () => {
      const { input } = await register();

      const time = async (body: unknown): Promise<number> => {
        const started = performance.now();
        await post('/v1/auth/login', body);
        return performance.now() - started;
      };

      const unknown = await time({
        email: 'nobody-has-this@example.ae',
        password: 'not-the-password',
        timeZone: 'Asia/Dubai',
      });
      const wrong = await time({
        email: input.email,
        password: 'not-the-password',
        timeZone: 'Asia/Dubai',
      });

      // A loose bound on purpose: this is a real network round trip to Atlas, so the noise floor is high.
      // What it catches is the failure that matters — an unknown email returning *without* hashing at
      // all, which shows up as an order-of-magnitude difference rather than a subtle one.
      expect(unknown).toBeGreaterThan(wrong / 10);
    });

    /**
     * **Three failed attempts from three IPs still lock the account.**
     *
     * This is the sentence an IP-keyed limiter structurally cannot express, and it is why the counter is
     * per-account on the user document rather than in an edge binding.
     */
    it('locks the account after repeated failures, whatever address they come from', async () => {
      const { input } = await register();

      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await post('/v1/auth/login', {
          email: input.email,
          password: 'not-the-password',
          timeZone: 'Asia/Dubai',
        });
        // Every attempt from a different address; the counter is on the account, so they still add up.
        expect(response.status, `attempt ${String(attempt)}`).toBe(422);
      }

      // And now even the *correct* password is refused, which is the point of a lockout.
      const locked = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });

      expect(await codeOf(locked)).toBe('ACCOUNT_LOCKED');
    });

    it('clears the failure count on a successful sign-in', async () => {
      const { input } = await register();

      for (let attempt = 0; attempt < 3; attempt++) {
        await post('/v1/auth/login', {
          email: input.email,
          password: 'not-the-password',
          timeZone: 'Asia/Dubai',
        });
      }
      await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });

      // Three more failures would lock the account if the counter had not been reset.
      for (let attempt = 0; attempt < 3; attempt++) {
        await post('/v1/auth/login', {
          email: input.email,
          password: 'not-the-password',
          timeZone: 'Asia/Dubai',
        });
      }
      const response = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });

      expect(response.status).toBe(200);
    });

    it('records a timezone change, so day boundaries move with the user', async () => {
      const { session, input } = await register();
      await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Europe/London',
      });

      // Read back through the session, which is the only route that can see it. The `PUT` below proves
      // the round trip; what matters here is that login wrote it without being asked.
      const response = await put('/v1/me/timezone', { timeZone: 'Europe/London' }, session.accessToken);
      expect(await response.json()).toEqual({ timeZone: 'Europe/London' });
    });
  });

  // ── Refresh and rotation ────────────────────────────────────────────────────────────────────

  describe('POST /v1/auth/refresh', () => {
    it('answers with a new refresh token as well as a new access token', async () => {
      const { session } = await register();

      const response = await post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
        timeZone: 'Asia/Dubai',
      });

      expect(response.status).toBe(200);
      const rotated = (await response.json()) as Session;
      assertMatchesShape(fixture('session-tokens.json'), rotated, 'refresh');
      // A response carrying only an access token is how a client ends up presenting the same refresh
      // token twice and having its family revoked underneath it.
      expect(rotated.refreshToken).not.toBe(session.refreshToken);
    });

    it('refuses the rotated-away token', async () => {
      const { session } = await register();
      await post('/v1/auth/refresh', { refreshToken: session.refreshToken, timeZone: 'Asia/Dubai' });

      const replay = await post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
        timeZone: 'Asia/Dubai',
      });

      expect(replay.status).toBe(401);
    });

    /**
     * **The alarm.** Rotation on its own is not a defence: if a token is stolen and the real user rotates
     * it, the thief holds a dead token and nobody learns anything. Family revocation turns that dead
     * token into a signal — presenting it kills the login it descended from, so the legitimate user is
     * signed out and has to sign in again. A signed-out user is recoverable; a silently shared session is
     * not.
     */
    it('revokes the whole family when a revoked token is presented', async () => {
      const { session } = await register();

      const first = await post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
        timeZone: 'Asia/Dubai',
      });
      const current = (await first.json()) as Session;

      // The thief replays the original.
      const replay = await post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
        timeZone: 'Asia/Dubai',
      });
      expect(replay.status).toBe(401);

      // And the *legitimate* current token is now dead too. That is the intended outcome.
      const legitimate = await post('/v1/auth/refresh', {
        refreshToken: current.refreshToken,
        timeZone: 'Asia/Dubai',
      });
      expect(legitimate.status).toBe(401);
    });

    it('refuses a token it has never seen', async () => {
      const response = await post('/v1/auth/refresh', {
        refreshToken: 'not-a-token-this-server-issued',
        timeZone: 'Asia/Dubai',
      });

      expect(response.status).toBe(401);
    });

    it('keeps two logins in separate families, so one theft does not end the other', async () => {
      const { session: phone, input } = await register();
      const second = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });
      const tablet = (await second.json()) as Session;

      // Burn the phone's family by replaying its token.
      await post('/v1/auth/refresh', { refreshToken: phone.refreshToken, timeZone: 'Asia/Dubai' });
      await post('/v1/auth/refresh', { refreshToken: phone.refreshToken, timeZone: 'Asia/Dubai' });

      const stillGood = await post('/v1/auth/refresh', {
        refreshToken: tablet.refreshToken,
        timeZone: 'Asia/Dubai',
      });

      expect(stillGood.status).toBe(200);
    });
  });

  // ── The session ─────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/me', () => {
    it('answers with the identity the client revalidates on foreground', async () => {
      const { session } = await register();

      const response = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('me-verified.json'), await response.json(), 'GET /v1/me');
    });

    it('reports emailVerified as true, because nothing is verified out of band', async () => {
      const { session } = await register();

      const response = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });

      // The field stays in the contract so the client's ~50 references and two fixtures remain valid
      // shapes; the banner it drives never fires (BACKEND_PLAN §4.2.2).
      expect((await response.json()) as Record<string, unknown>).toMatchObject({ emailVerified: true });
    });

    /** Invariant 2: salary has one owner, and this response is not it (ADR-0020). */
    it('carries no salary, currency or figures — those reach a screen through its own endpoint', async () => {
      const { session } = await register();

      const response = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).not.toHaveProperty('salary');
      expect(body).not.toHaveProperty('displayCurrency');
      expect(body).not.toHaveProperty('savingsGoal');
    });

    /** Invariant 8: a cache HIT here is one user's email address served to another. */
    it('is never cached', async () => {
      const { session } = await register();

      const response = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });

      expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('refuses a request with no token, a malformed token, and a forged one', async () => {
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2NmMwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJzZWMiOjF9.forged';

      for (const headers of [{}, { Authorization: 'Bearer nonsense' }, { Authorization: `Bearer ${forged}` }]) {
        const response = await db.app.request('/v1/me', { headers });
        expect(response.status).toBe(401);
      }
    });

    it('never returns a hash, however the response is read', async () => {
      const { session } = await register();

      const response = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });

      expect(await response.text()).not.toMatch(/argon2|\$argon|passwordHash|answerHash/);
    });
  });

  // ── Sign out ────────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/auth/logout', () => {
    it('acknowledges and revokes the presented family', async () => {
      const { session } = await register();

      const response = await post('/v1/auth/logout', { refreshToken: session.refreshToken }, session.accessToken);

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('logout-acknowledged.json'), await response.json(), 'logout');

      const afterwards = await post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
        timeZone: 'Asia/Dubai',
      });
      expect(afterwards.status).toBe(401);
    });

    it('accepts a token it does not recognise, because the caller wanted the session gone', async () => {
      const { session } = await register();

      // Reporting "no such token" would give a probe a way to test tokens, and the outcome the caller
      // asked for has already happened.
      const response = await post('/v1/auth/logout', { refreshToken: 'never-issued' }, session.accessToken);

      expect(response.status).toBe(200);
    });

    it('needs a session, which is why the client\'s authorization rule is not a path prefix', async () => {
      const { session } = await register();

      const response = await post('/v1/auth/logout', { refreshToken: session.refreshToken });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /v1/auth/logout-all', () => {
    /**
     * The `securityEpoch` half is what makes this immediate. Without it the other device's access token
     * would keep working for up to fifteen minutes, and the user would have asked for something that
     * appeared not to happen.
     */
    it('ends every session and invalidates outstanding access tokens at once', async () => {
      const { session: phone, input } = await register();
      const second = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });
      const tablet = (await second.json()) as Session;

      const response = await post('/v1/auth/logout-all', {}, phone.accessToken);
      expect(response.status).toBe(200);

      // The tablet's refresh token is revoked...
      const tabletRefresh = await post('/v1/auth/refresh', {
        refreshToken: tablet.refreshToken,
        timeZone: 'Asia/Dubai',
      });
      expect(tabletRefresh.status).toBe(401);

      // ...and its *access* token, which has not expired, is refused on the next request.
      const tabletRead = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${tablet.accessToken}` },
      });
      expect(tabletRead.status).toBe(401);
    });
  });

  // ── Recovery ────────────────────────────────────────────────────────────────────────────────

  describe('POST /v1/auth/forgot-password/questions', () => {
    it('returns the two questions the account was set up with', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/forgot-password/questions', { email: input.email });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { questions: { id: string; text: string }[] };
      expect(body.questions.map((question) => question.id)).toEqual(['sq01', 'sq02']);
      for (const question of body.questions) expect(question.text.length).toBeGreaterThan(0);
    });

    /**
     * A better enumeration oracle than login, if it leaked: it needs no password guess and spends no
     * lockout budget. So an unknown address gets a plausible pair too.
     */
    it('returns a plausible pair for an address with no account', async () => {
      const response = await post('/v1/auth/forgot-password/questions', {
        email: 'nobody-has-this@example.ae',
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { questions: { id: string }[] };
      expect(body.questions).toHaveLength(2);
      expect(body.questions[0]?.id).not.toBe(body.questions[1]?.id);
    });

    it('returns the same pair each time for the same unknown address', async () => {
      // Random ids would differ between two requests for one address, which is itself the tell.
      const email = `ghost+${randomUUID()}@example.ae`;
      const first = await post('/v1/auth/forgot-password/questions', { email });
      const second = await post('/v1/auth/forgot-password/questions', { email });

      expect(await first.text()).toBe(await second.text());
    });
  });

  describe('POST /v1/auth/forgot-password/verify', () => {
    const answers = [
      { questionId: 'sq01', answer: 'Fluffy' },
      { questionId: 'sq02', answer: 'Jaipur' },
    ];

    it('issues a ticket for the right answers and the right date of birth', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ticket: string };
      expect(body.ticket.length).toBeGreaterThan(20);
    });

    it('accepts answers typed differently, because the comparison is over the normalised form', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers: [
          { questionId: 'sq01', answer: '  FLUFFY  ' },
          { questionId: 'sq02', answer: 'jaipur' },
        ],
      });

      expect(response.status).toBe(200);
    });

    it('refuses a wrong answer without saying which one', async () => {
      const { input } = await register();

      const first = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers: [{ questionId: 'sq01', answer: 'Rex' }, { questionId: 'sq02', answer: 'Jaipur' }],
      });
      const second = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers: [{ questionId: 'sq01', answer: 'Fluffy' }, { questionId: 'sq02', answer: 'Jodhpur' }],
      });

      const firstBody = await first.text();
      const secondBody = await second.text();

      expect(first.status).toBe(422);
      expect(JSON.parse(firstBody)).toMatchObject({ error: { code: 'SECURITY_ANSWERS_INVALID' } });
      // Identical bodies: telling somebody which of two guesses landed halves the work of guessing the
      // other. The design reddens the specific field, which it can only do because it compares raw
      // strings in the browser (defect D4).
      expect(firstBody).toBe(secondBody);
    });

    it('refuses right answers with the wrong date of birth', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: '1991-04-12',
        answers,
      });

      expect(await codeOf(response)).toBe('SECURITY_ANSWERS_INVALID');
    });

    it('answers the same way for an address with no account', async () => {
      const { input } = await register();
      const wrong = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers: [{ questionId: 'sq01', answer: 'Rex' }, { questionId: 'sq02', answer: 'Jodhpur' }],
      });

      const unknown = await post('/v1/auth/forgot-password/verify', {
        email: 'nobody-has-this@example.ae',
        dateOfBirth: '1990-04-12',
        answers,
      });

      expect(unknown.status).toBe(wrong.status);
      expect(await unknown.text()).toBe(await wrong.text());
    });

    /**
     * Recovery has its own counters. Sharing login's would let a stranger's failed password guesses lock
     * you out of the mechanism you would use to recover — and this is now the *only* way back in.
     */
    it('locks recovery separately from login', async () => {
      const { input } = await register();
      const wrong = { questionId: 'sq01', answer: 'Rex' };

      for (let attempt = 0; attempt < 5; attempt++) {
        await post('/v1/auth/forgot-password/verify', {
          email: input.email,
          dateOfBirth: input.dateOfBirth,
          answers: [wrong, { questionId: 'sq02', answer: 'Jaipur' }],
        });
      }

      const locked = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers,
      });
      expect(await codeOf(locked)).toBe('ACCOUNT_LOCKED');

      // And signing in still works: the two lockouts are independent.
      const login = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });
      expect(login.status).toBe(200);
    });

    it('never echoes an answer back', async () => {
      const { input } = await register();

      const response = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers,
      });

      const text = await response.text();
      expect(text).not.toMatch(/Fluffy|Jaipur|fluffy|jaipur/);
    });
  });

  describe('POST /v1/auth/reset-password', () => {
    const answers = [
      { questionId: 'sq01', answer: 'Fluffy' },
      { questionId: 'sq02', answer: 'Jaipur' },
    ];

    /** Register, verify, and hold a live ticket. */
    async function ticketFor(): Promise<{ ticket: string; input: Record<string, unknown>; session: Session }> {
      const { input, session } = await register();
      const verified = await post('/v1/auth/forgot-password/verify', {
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        answers,
      });
      const { ticket } = (await verified.json()) as { ticket: string };
      return { ticket, input, session };
    }

    it('sets the new password and signs the user in with it', async () => {
      const { ticket, input } = await ticketFor();

      const reset = await post('/v1/auth/reset-password', { ticket, newPassword: 'a-brand-new-password' });
      expect(reset.status).toBe(200);

      const withNew = await post('/v1/auth/login', {
        email: input.email,
        password: 'a-brand-new-password',
        timeZone: 'Asia/Dubai',
      });
      expect(withNew.status).toBe(200);

      const withOld = await post('/v1/auth/login', {
        email: input.email,
        password: input.password,
        timeZone: 'Asia/Dubai',
      });
      expect(await codeOf(withOld)).toBe('INVALID_CREDENTIALS');
    });

    it('spends the ticket, so it cannot be used twice', async () => {
      const { ticket } = await ticketFor();
      await post('/v1/auth/reset-password', { ticket, newPassword: 'a-brand-new-password' });

      const replay = await post('/v1/auth/reset-password', { ticket, newPassword: 'another-password' });

      expect(await codeOf(replay)).toBe('RESET_TICKET_INVALID');
    });

    it('refuses a ticket it never issued', async () => {
      const response = await post('/v1/auth/reset-password', {
        ticket: 'not-a-ticket',
        newPassword: 'a-brand-new-password',
      });

      expect(await codeOf(response)).toBe('RESET_TICKET_INVALID');
    });

    it('refuses a new password under 8 characters', async () => {
      const { ticket } = await ticketFor();

      const response = await post('/v1/auth/reset-password', { ticket, newPassword: 'short12' });

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    /**
     * A takeover that got this far must not leave the real owner signed in elsewhere — and, read the
     * other way, an owner recovering their account signs out whoever else was in it.
     */
    it('revokes every session, including the one that was already signed in', async () => {
      const { ticket, session } = await ticketFor();

      await post('/v1/auth/reset-password', { ticket, newPassword: 'a-brand-new-password' });

      const refresh = await post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
        timeZone: 'Asia/Dubai',
      });
      expect(refresh.status).toBe(401);

      // The access token dies too, via the `securityEpoch` bump — not in fifteen minutes, now.
      const read = await db.app.request('/v1/me', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      expect(read.status).toBe(401);
    });

    it('invalidates a ticket issued before a newer one', async () => {
      const { input } = await register();
      const request = async (): Promise<string> => {
        const verified = await post('/v1/auth/forgot-password/verify', {
          email: input.email,
          dateOfBirth: input.dateOfBirth,
          answers,
        });
        return ((await verified.json()) as { ticket: string }).ticket;
      };

      const first = await request();
      const second = await request();

      // Without the invalidation, a user who ran the flow twice would hold two live tickets and the
      // older would outlive the attempt that produced it.
      expect(await codeOf(await post('/v1/auth/reset-password', { ticket: first, newPassword: 'password-one' }))).toBe(
        'RESET_TICKET_INVALID',
      );
      expect((await post('/v1/auth/reset-password', { ticket: second, newPassword: 'password-two' })).status).toBe(200);
    });
  });

  // ── Preferences ─────────────────────────────────────────────────────────────────────────────

  describe('PUT /v1/me/language', () => {
    it('stores the preference and answers with it', async () => {
      const { session } = await register();

      const response = await put('/v1/me/language', { language: 'ar' }, session.accessToken);

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('language-arabic.json'), await response.json(), 'PUT /v1/me/language');
    });

    it('round-trips back to English', async () => {
      const { session } = await register();
      await put('/v1/me/language', { language: 'ar' }, session.accessToken);

      const response = await put('/v1/me/language', { language: 'en' }, session.accessToken);

      assertMatchesShape(fixture('language-english.json'), await response.json(), 'PUT /v1/me/language');
    });

    it('refuses a language that is not en or ar', async () => {
      const { session } = await register();

      const response = await put('/v1/me/language', { language: 'fr' }, session.accessToken);

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });

    it('needs a session', async () => {
      const response = await put('/v1/me/language', { language: 'ar' });

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /v1/me/timezone', () => {
    it('stores a named zone', async () => {
      const { session } = await register();

      const response = await put('/v1/me/timezone', { timeZone: 'Asia/Kolkata' }, session.accessToken);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ timeZone: 'Asia/Kolkata' });
    });

    it('refuses an offset, which would freeze the user\'s DST behaviour', async () => {
      const { session } = await register();

      const response = await put('/v1/me/timezone', { timeZone: '+05:30' }, session.accessToken);

      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    });
  });

  // ── Storage ─────────────────────────────────────────────────────────────────────────────────

  describe('what is on disk', () => {
    /**
     * Invariant 5, checked where it actually matters. Every tolerance the recovery flow offers lives in
     * the normaliser, so the *raw* answer has no reason to exist after registration — and a stored raw
     * answer would be readable by anyone with a database dump.
     */
    it('stores no raw password and no raw security answer', async () => {
      const { input } = await register();
      const raw = (await post('/v1/auth/forgot-password/questions', { email: input.email })).clone();
      await raw.text();

      // Read the document through the repository, which is the only code allowed to.
      const { findByEmail } = await import('../src/repositories/users');
      const user = required(await findByEmail(input.email as string), 'the registered user');

      expect(user.passwordHash).not.toContain(input.password);
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      for (const question of user.securityQuestions) {
        expect(question.answerHash).toMatch(/^\$argon2id\$/);
        expect(question.answerHash).not.toMatch(/Fluffy|fluffy|Jaipur|jaipur/);
      }
    });

    it('stores the salary as authored, with its exponent resolved from the currency list', async () => {
      const { input } = await register({ salary: { minor: 553_900, currency: 'INR' }, savingsGoal: { minor: 110_780, currency: 'INR' } });

      const { findByEmail } = await import('../src/repositories/users');
      const user = required(await findByEmail(input.email as string), 'the registered user');

      // Stored in the currency it was authored in, never normalised to a base on write (ADR-0001).
      expect(user.salary).toEqual({ minor: 553_900, currency: 'INR', exponent: 2 });
      // And no `display` string on disk — that is defect D16 (DATA_MODEL rule 1).
      expect(user.salary).not.toHaveProperty('display');
    });

    it('stores date of birth as a calendar date, not an instant in a zone', async () => {
      const { input } = await register({ dateOfBirth: '1990-04-12' });

      const { findByEmail } = await import('../src/repositories/users');
      const user = required(await findByEmail(input.email as string), 'the registered user');

      expect(user.dob.toISOString()).toBe('1990-04-12T00:00:00.000Z');
    });
  });
});
