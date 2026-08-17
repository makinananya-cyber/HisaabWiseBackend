import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getContent, type Lesson } from '../src/content';
import { assertMatchesAnyShape, assertMatchesShape } from './contract/shape';
import { canReachDatabase, setupDatabase, skipReason, type TestDatabase } from './support/database';
import { required } from './support/expect';
import { fixture } from './support/fixture';

/**
 * Slice 5's integration test — Learn end to end.
 *
 * The properties: a forged high-XP submission is rejected, replaying a lesson earns nothing, the streak
 * ignores the device clock and survives a reinstall because it is server-owned, and the PDF downloads.
 */

const describeIntegration = canReachDatabase() ? describe : describe.skip;
if (!canReachDatabase()) console.warn(`[learn.test] skipped: ${skipReason}`);

describeIntegration('Learn', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await setupDatabase();
    await db.clear();
  });

  afterAll(async () => {
    await db.drop();
  });

  const lessonOf = (id: string): Lesson => required(getContent('en').lessonById.get(id), `lesson ${id}`);

  /** Every question in a lesson, answered correctly. */
  const perfectRun = (lesson: Lesson): { stepIndex: number; isCorrect: boolean }[] =>
    lesson.steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step }) => step.kind !== 'teach')
      .map(({ stepIndex }) => ({ stepIndex, isCorrect: true }));

  async function register(): Promise<string> {
    const response = await db.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ananya',
        email: `learn+${randomUUID()}@example.ae`,
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
    return accessToken;
  }

  const request = async (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
    db.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  interface Screen {
    streak: { value: number; display: string; accessibilityLabel: string };
    xp: { value: number; display: string; accessibilityLabel: string };
    currencyToken: string;
    nextLesson?: { unitId: string; lessonId: string; title: string };
    units: { id: string; isUnlocked: boolean }[];
    lessons: { id: string; state: string; segments: number; filledSegments: number; progressLabel: string }[];
  }

  interface Completion {
    isFirstCompletion: boolean;
    xpEarned: { value: number; display: string };
    accuracy: { value: number; display: string };
    streakLine: string;
    week: { label: string; isComplete: boolean; isToday: boolean; accessibilityLabel: string }[];
    screen: Screen;
  }

  const learn = async (token: string): Promise<Screen> => {
    const response = await request('GET', '/v1/screens/learn', token);
    expect(response.status).toBe(200);
    return (await response.json()) as Screen;
  };

  const complete = async (
    token: string,
    lessonId: string,
    results?: { stepIndex: number; isCorrect: boolean }[],
  ): Promise<Response> =>
    request('POST', `/v1/learn/lessons/${lessonId}/complete`, token, {
      results: results ?? perfectRun(lessonOf(lessonId)),
    });

  const completionOf = async (response: Response): Promise<Completion> => {
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Completion;
  };

  const lessonIn = (screen: Screen, id: string): Screen['lessons'][number] =>
    required(
      screen.lessons.find((lesson) => lesson.id === id),
      `lesson ${id}`,
    );

  // ── The contract ────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/screens/learn', () => {
    it('satisfies the first-run contract', async () => {
      const token = await register();
      const response = await request('GET', '/v1/screens/learn', token);

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('learn-first-run.json'), await response.json(), 'GET /v1/screens/learn');
    });

    it('satisfies the in-progress contract once a lesson is done', async () => {
      const token = await register();
      await complete(token, 'u1l1');

      const response = await request('GET', '/v1/screens/learn', token);
      assertMatchesShape(fixture('learn-in-progress.json'), await response.json(), 'GET /v1/screens/learn');
    });

    it('carries all fifteen lessons and five units', async () => {
      const screen = await learn(await register());

      expect(screen.lessons).toHaveLength(15);
      expect(screen.units).toHaveLength(5);
      // Only the first unit is open to a new reader.
      expect(screen.units.map((unit) => unit.isUnlocked)).toEqual([true, false, false, false, false]);
    });

    it('carries accessible labels for the zero case as sentences', async () => {
      const screen = await learn(await register());

      // "No streak yet" rather than "0-day streak": a screen reader should say what it means.
      expect(screen.streak.accessibilityLabel).toBe('No streak yet');
      expect(screen.xp.accessibilityLabel).toBe('No experience points yet');
    });

    it('names the first lesson as next', async () => {
      const screen = await learn(await register());

      expect(screen.nextLesson).toEqual({ unitId: 'u1', lessonId: 'u1l1', title: 'Gross vs. Net Income' });
    });

    it('is never cached', async () => {
      const token = await register();

      expect((await request('GET', '/v1/screens/learn', token)).headers.get('cache-control')).toContain(
        'no-store',
      );
    });
  });

  // ── Completing a lesson ─────────────────────────────────────────────────────────────────────

  describe('POST /v1/learn/lessons/:id/complete', () => {
    it('satisfies the completion contract', async () => {
      const token = await register();
      const response = await complete(token, 'u1l1');

      expect(response.status).toBe(200);
      assertMatchesShape(fixture('lesson-completed.json'), await response.json(), 'lesson completion');
    });

    it('awards ten a correct answer plus the twenty bonus', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');

      const completion = await completionOf(await complete(token, 'u1l1'));

      const questions = perfectRun(lesson).length;
      expect(completion.xpEarned.value).toBe(questions * 10 + 20);
      expect(completion.xpEarned.display).toBe(`+${String(questions * 10 + 20)}`);
      expect(completion.accuracy.value).toBe(100);
      expect(completion.isFirstCompletion).toBe(true);
      expect(completion.screen.xp.value).toBe(questions * 10 + 20);
    });

    it('recomputes XP from the results rather than trusting the client', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');
      // One wrong answer, honestly reported.
      const run = perfectRun(lesson).map((result, index) => ({ ...result, isCorrect: index !== 0 }));

      const completion = await completionOf(await complete(token, 'u1l1', run));

      const correct = run.length - 1;
      expect(completion.xpEarned.value).toBe(correct * 10 + 20);
      expect(completion.accuracy.value).toBe(Math.round((correct / run.length) * 100));
    });

    it('starts the streak at one and says so', async () => {
      const token = await register();

      const completion = await completionOf(await complete(token, 'u1l1'));

      expect(completion.screen.streak.value).toBe(1);
      // **`day`, singular.** Every reader's first completed lesson lands on exactly this sentence, so the
      // plural was not an edge case — it was the first thing the app ever said about their streak.
      expect(completion.streakLine).toContain('Your streak just grew to 1 day.');
    });

    it('does not grow the streak twice in one day', async () => {
      const token = await register();
      await complete(token, 'u1l1');

      const second = await completionOf(await complete(token, 'u1l2'));

      // The second lesson of the day earns XP but not a streak day.
      expect(second.screen.streak.value).toBe(1);
      expect(second.streakLine).toBe('You have already learned something today — that is how this compounds.');
    });

    it('unlocks the next lesson', async () => {
      const token = await register();

      const completion = await completionOf(await complete(token, 'u1l1'));

      expect(lessonIn(completion.screen, 'u1l1').state).toBe('completed');
      expect(lessonIn(completion.screen, 'u1l2').state).toBe('available');
      expect(lessonIn(completion.screen, 'u1l3').state).toBe('locked');
      expect(completion.screen.nextLesson?.lessonId).toBe('u1l2');
    });

    it('draws the ring from the number answered correctly', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');
      const run = perfectRun(lesson).map((result, index) => ({ ...result, isCorrect: index !== 0 }));

      const completion = await completionOf(await complete(token, 'u1l1', run));

      const row = lessonIn(completion.screen, 'u1l1');
      expect(row.filledSegments).toBe(run.length - 1);
      expect(row.segments).toBe(run.length);
      expect(row.progressLabel).toBe(
        `Completed, ${String(run.length - 1)} of ${String(run.length)} questions right`,
      );
    });

    it('carries a week strip with today marked', async () => {
      const token = await register();

      const completion = await completionOf(await complete(token, 'u1l1'));

      expect(completion.week).toHaveLength(7);
      expect(completion.week.map((day) => day.label)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
      const today = required(
        completion.week.find((day) => day.isToday),
        'a day marked today',
      );
      expect(today.isComplete).toBe(true);
      expect(today.accessibilityLabel).toBe('Today, lesson finished');
    });

    // ── Replay ────────────────────────────────────────────────────────────────────────────────

    /** Defect D13: the prototype awarded XP every time a lesson was replayed. */
    it('earns nothing on a replay', async () => {
      const token = await register();
      const first = await completionOf(await complete(token, 'u1l1'));

      const replay = await completionOf(await complete(token, 'u1l1'));

      expect(replay.isFirstCompletion).toBe(false);
      expect(replay.xpEarned.value).toBe(0);
      expect(replay.xpEarned.display).toBe('0');
      // The total is unchanged: a replay is not a second award.
      expect(replay.screen.xp.value).toBe(first.screen.xp.value);
    });

    it('satisfies the revisited contract', async () => {
      const token = await register();
      await complete(token, 'u1l1');

      const response = await complete(token, 'u1l1');
      assertMatchesShape(fixture('lesson-revisited.json'), await response.json(), 'lesson revisited');
    });

    it('lets a better second run fill the ring', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');
      const flawed = perfectRun(lesson).map((result, index) => ({ ...result, isCorrect: index !== 0 }));

      await complete(token, 'u1l1', flawed);
      const better = await completionOf(await complete(token, 'u1l1'));

      // A reader who scored 3 of 4 and then 4 of 4 has earned the full ring, even though the XP is spent.
      expect(lessonIn(better.screen, 'u1l1').filledSegments).toBe(perfectRun(lesson).length);
      expect(better.xpEarned.value).toBe(0);
    });

    // ── Refusals ──────────────────────────────────────────────────────────────────────────────

    /** **The forged-progress test.** Each refusal closes one route to XP that was not earned. */
    it('refuses a lesson whose predecessor is unfinished', async () => {
      const token = await register();

      const response = await complete(token, 'u1l3');

      expect(response.status).toBe(403);
    });

    it('refuses a result naming a step that is not a question', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');
      const teachIndex = lesson.steps.findIndex((step) => step.kind === 'teach');

      const response = await complete(token, 'u1l1', [
        ...perfectRun(lesson),
        { stepIndex: teachIndex, isCorrect: true },
      ]);

      expect(response.status).toBe(422);
    });

    it('refuses a question answered twice', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');
      const run = perfectRun(lesson);

      const response = await complete(token, 'u1l1', [...run, required(run[0], 'a question')]);

      expect(response.status).toBe(422);
    });

    it('refuses a run that used a fourth heart', async () => {
      const token = await register();
      const lesson = lessonOf('u2l2');
      // First get there.
      for (const id of ['u1l1', 'u1l2', 'u1l3', 'u2l1']) await complete(token, id);

      const run = perfectRun(lesson).map((result, index) => ({ ...result, isCorrect: index >= 4 }));
      const response = await complete(token, 'u2l2', run);

      expect(response.status).toBe(422);
    });

    it('refuses a completion that skipped a question', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');

      const response = await complete(token, 'u1l1', perfectRun(lesson).slice(0, -1));

      expect(response.status).toBe(422);
    });

    it('refuses an unknown lesson', async () => {
      const token = await register();

      const response = await complete(token, 'u9l9', []);

      expect(response.status).toBe(404);
    });

    it('needs a session', async () => {
      const response = await db.app.request('/v1/learn/lessons/u1l1/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: [] }),
      });

      expect(response.status).toBe(401);
    });
  });

  // ── Partial progress ────────────────────────────────────────────────────────────────────────

  describe('POST /v1/learn/progress', () => {
    it('records a position and earns nothing', async () => {
      const token = await register();
      const lesson = lessonOf('u1l1');

      const response = await request('POST', '/v1/learn/progress', token, {
        lessonId: 'u1l1',
        stepIndex: Math.floor(lesson.steps.length / 2),
        results: perfectRun(lesson).slice(0, 2),
      });

      expect(response.status).toBe(200);
      const screen = (await response.json()) as Screen;
      expect(screen.xp.value).toBe(0);
      expect(screen.streak.value).toBe(0);
      expect(lessonIn(screen, 'u1l1').state).toBe('available');
      expect(lessonIn(screen, 'u1l1').filledSegments).toBeGreaterThan(0);
    });

    it('accepts a partial run without demanding every question', async () => {
      const token = await register();
      // The lesson's *first question*, not an arbitrary step: index 3 is a teach page in u1l1, and
      // reporting an answer for one is correctly refused.
      const firstQuestion = required(perfectRun(lessonOf('u1l1'))[0], 'the first question');

      const response = await request('POST', '/v1/learn/progress', token, {
        lessonId: 'u1l1',
        stepIndex: firstQuestion.stepIndex,
        results: [firstQuestion],
      });

      // A reader who left after one question is reporting a real position.
      expect(response.status).toBe(200);
    });

    it('still refuses an impossible partial run', async () => {
      const token = await register();

      const response = await request('POST', '/v1/learn/progress', token, {
        lessonId: 'u1l1',
        stepIndex: 3,
        results: [{ stepIndex: 199, isCorrect: true }],
      });

      expect(response.status).toBe(422);
    });

    it('refuses an answer reported for a teach page', async () => {
      const token = await register();
      const teachIndex = lessonOf('u1l1').steps.findIndex((step) => step.kind === 'teach');

      const response = await request('POST', '/v1/learn/progress', token, {
        lessonId: 'u1l1',
        stepIndex: teachIndex,
        results: [{ stepIndex: teachIndex, isCorrect: true }],
      });

      expect(response.status).toBe(422);
    });

    it('is cleared when the lesson is finished', async () => {
      const token = await register();
      const firstQuestion = required(perfectRun(lessonOf('u1l1'))[0], 'the first question');
      await request('POST', '/v1/learn/progress', token, {
        lessonId: 'u1l1',
        stepIndex: firstQuestion.stepIndex,
        results: [firstQuestion],
      });

      const completion = await completionOf(await complete(token, 'u1l1'));

      // Finished, so there is nothing to resume.
      expect(lessonIn(completion.screen, 'u1l1').state).toBe('completed');
    });
  });

  describe('GET /v1/learn/progress', () => {
    it('answers with the Learn screen', async () => {
      const token = await register();
      const response = await request('GET', '/v1/learn/progress', token);

      expect(response.status).toBe(200);
      assertMatchesAnyShape(
        [
          { name: 'learn-first-run.json', value: fixture('learn-first-run.json') },
          { name: 'learn-complete.json', value: fixture('learn-complete.json') },
        ],
        await response.json(),
        'GET /v1/learn/progress',
      );
    });
  });

  // ── Progress survives ───────────────────────────────────────────────────────────────────────

  describe('progress is server-owned', () => {
    /**
     * A reinstall is a new device with no local state. The streak and the XP come back because they were
     * never on the device — which is the point of storing them here.
     */
    it('survives a reinstall, because a fresh sign-in reads the same record', async () => {
      // Register, learn something, then sign in again with a brand-new token pair — which is exactly what
      // a reinstall looks like from here: a device with no local state presenting credentials.
      const email = `reinstall+${randomUUID()}@example.ae`;
      const password = 'a-good-enough-password';
      const created = await db.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ananya',
          email,
          dateOfBirth: '1994-06-20',
          password,
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
      const first = (await created.json()) as { accessToken: string };
      const earned = (await completionOf(await complete(first.accessToken, 'u1l1'))).screen.xp.value;

      const signedIn = await db.app.request('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, timeZone: 'Asia/Kolkata' }),
      });
      const second = (await signedIn.json()) as { accessToken: string };

      const screen = await learn(second.accessToken);
      expect(screen.xp.value).toBe(earned);
      expect(screen.streak.value).toBe(1);
      expect(lessonIn(screen, 'u1l1').state).toBe('completed');
    });
  });

  // ── The takeaway ────────────────────────────────────────────────────────────────────────────

  describe('GET /v1/content/curriculum/pdf', () => {
    /** ADR-0019 removed offline lessons and gave that job to this file — it is the whole offline story. */
    it('downloads a real PDF', async () => {
      const token = await register();
      const response = await request('GET', '/v1/content/curriculum/pdf', token);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(response.headers.get('content-disposition')).toContain('hisaabwise-curriculum.pdf');

      const bytes = new Uint8Array(await response.arrayBuffer());
      // A PDF starts with `%PDF-`. Non-triviality matters as much: 124 steps is not a one-page document.
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
      expect(bytes.byteLength).toBeGreaterThan(20_000);
    });

    it('revalidates with an ETag rather than regenerating', async () => {
      const token = await register();
      const first = await request('GET', '/v1/content/curriculum/pdf', token);
      const etag = required(first.headers.get('etag'), 'a PDF ETag');

      const second = await db.app.request('/v1/content/curriculum/pdf', {
        headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag },
      });

      expect(second.status).toBe(304);
    });

    it('needs a session, because the currency comes from the user', async () => {
      expect((await db.app.request('/v1/content/curriculum/pdf')).status).toBe(401);
    });
  });
});
