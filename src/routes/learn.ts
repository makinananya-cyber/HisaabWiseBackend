import { createHash } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { getContent, resolveLanguage } from '../content';
import { renderPdf } from '../content/pdfRenderer';
import {
  correctCount,
  currentStreak,
  HEARTS,
  questionCount,
  streakAfterCompletion,
  submissionProblems,
  xpFor,
} from '../domain/learn';
import { dayKey } from '../domain/time';
import { ApiError } from '../errors';
import { requireSession } from '../middleware/auth';
import * as learnProgress from '../repositories/learnProgress';
import { buildCompletion, buildLearn, type LearnPayload } from '../screens/learn';
import type { AppEnv } from '../types/hono';
import type { User } from '../repositories/users';

/**
 * Learn — the screen, the submissions, and the takeaway PDF.
 *
 * **The client grades and the server re-grades** (invariant 10). Every submission carries one result per
 * question, the server recomputes the XP from them, and a submission that could not have happened is
 * refused with `422` — which the client reads as a definite failure rather than something to retry.
 */

export const learnRoutes = new Hono<AppEnv>();

async function body<Schema extends z.ZodType>(c: Context<AppEnv>, schema: Schema): Promise<z.infer<Schema>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', 'the request body was not valid', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/** Read a user's progress and build the screen. Shared by the read and both writes. */
async function currentLearn(user: User, now: Date, language: Parameters<typeof getContent>[0]): Promise<LearnPayload> {
  const stored = await learnProgress.forUser(user._id);
  return buildLearn({
    user,
    now,
    progress: learnProgress.asProgress(stored),
    language: language ?? 'en',
  });
}

learnRoutes.get('/v1/screens/learn', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');
  const language = resolveLanguage(c.req.header('accept-language'));
  return c.json(await currentLearn(c.var.user, new Date(), language));
});

/**
 * `GET /v1/learn/progress` — the same payload as the screen.
 *
 * The client declares this path as the collection its `POST` hangs off, and reads it as the Learn screen.
 * One shape, so there is nothing extra to model.
 */
learnRoutes.get('/v1/learn/progress', requireSession(), async (c) => {
  c.header('Cache-Control', 'no-store');
  const language = resolveLanguage(c.req.header('accept-language'));
  return c.json(await currentLearn(c.var.user, new Date(), language));
});

const resultSchema = z.object({
  stepIndex: z.number().int().min(0).max(200),
  isCorrect: z.boolean(),
});

/**
 * Turn the domain's problems into the one refusal.
 *
 * **One code for every shape of impossibility**, with the specifics in the log. A caller probing for which
 * check they tripped is exactly who would benefit from a breakdown, and an honest client never sees this.
 */
function assertSubmissionPossible(
  lesson: Parameters<typeof submissionProblems>[0],
  results: readonly { stepIndex: number; isCorrect: boolean }[],
  requireEveryQuestion: boolean,
): void {
  const problems = submissionProblems(lesson, results, requireEveryQuestion);
  if (problems.length === 0) return;

  throw new ApiError('VALIDATION_FAILED', 'that lesson submission could not have happened', {
    lessonId: lesson.id,
    problems,
    hearts: HEARTS,
  });
}

/**
 * `POST /v1/learn/progress` — how far into a lesson the reader got.
 *
 * Earns nothing: no XP, no streak. A failure here is **nobody's problem** — the reader has left the lesson,
 * there is no write queue (ADR-0019), and a partial position that did not save costs them the tail of one
 * run rather than anything they had earned.
 *
 * The results are still validated, because a position report is also a claim about which questions were
 * answered, and the ring is drawn from it.
 */
learnRoutes.post('/v1/learn/progress', requireSession(), async (c) => {
  const input = await body(
    c,
    z.object({
      lessonId: z.string().min(1).max(50),
      stepIndex: z.number().int().min(0).max(200),
      results: z.array(resultSchema).max(50),
    }),
  );

  const user = c.var.user;
  const now = new Date();
  const language = resolveLanguage(c.req.header('accept-language'));

  const lesson = getContent(language).lessonById.get(input.lessonId);
  if (lesson === undefined) throw new ApiError('NOT_FOUND', 'no such lesson');

  assertSubmissionPossible(lesson, input.results, false);
  assertUnlocked(user, lesson.id, await learnProgress.forUser(user._id), language);

  await learnProgress.recordPosition(user._id, input.lessonId, input.stepIndex, now);

  c.header('Cache-Control', 'no-store');
  return c.json(await currentLearn(user, now, language));
});

/**
 * `POST /v1/learn/lessons/:id/complete` — a finished lesson.
 *
 * Five refusals, and each one closes a way to forge progress:
 *
 *  - a lesson whose predecessor is unfinished (**sequential unlocking**)
 *  - a result naming a step that is not a question
 *  - a question answered twice
 *  - more than three wrong answers (**a run that used a fourth heart ended**)
 *  - a completion that does not cover every question in the lesson
 *
 * **XP is granted on first completion only** (defect D13). A replay updates the counts the ring is drawn
 * from — a better second run should show a fuller ring — but earns nothing, and `isFirstCompletion` tells
 * the client which screen to draw.
 */
learnRoutes.post('/v1/learn/lessons/:id/complete', requireSession(), async (c) => {
  const lessonId = c.req.param('id');
  const input = await body(c, z.object({ results: z.array(resultSchema).max(50) }));

  const user = c.var.user;
  const now = new Date();
  const language = resolveLanguage(c.req.header('accept-language'));

  const lesson = getContent(language).lessonById.get(lessonId);
  if (lesson === undefined) throw new ApiError('NOT_FOUND', 'no such lesson');

  const stored = await learnProgress.forUser(user._id);
  assertUnlocked(user, lessonId, stored, language);
  assertSubmissionPossible(lesson, input.results, true);

  const correct = correctCount(input.results);
  const total = questionCount(lesson);
  const isFirstCompletion = !(lessonId in stored.done);
  // Recomputed from the results, never taken from the client.
  const xpAwarded = isFirstCompletion ? xpFor(correct) : 0;

  const today = dayKey(now, user.timezone);
  const streak = streakAfterCompletion(
    currentStreak(stored.streak, stored.lastActiveDayKey, today),
    stored.lastActiveDayKey,
    today,
  );

  await learnProgress.recordCompletion(
    user._id,
    lessonId,
    { correct, total, xpAwarded },
    { value: streak.streak, dayKey: today },
    now,
  );

  c.var.log.info(
    { userId: user._id.toHexString(), lessonId, correct, total, xpAwarded, isFirstCompletion },
    'lesson completed',
  );

  const after = await learnProgress.forUser(user._id);
  c.header('Cache-Control', 'no-store');

  return c.json(
    buildCompletion({
      isFirstCompletion,
      xpAwarded,
      correct,
      total,
      streak: streak.streak,
      streakGrew: streak.grew,
      activeDayKeys: after.activeDayKeys,
      todayDayKey: today,
      screen: buildLearn({ user, now, progress: learnProgress.asProgress(after), language }),
    }),
  );
});

/**
 * Refuse a submission for a lesson the reader has not reached.
 *
 * Sequential unlocking is a *progress* rule rather than a security one, but it is enforced here anyway: a
 * client that skipped ahead would otherwise bank XP for lessons it never showed anybody.
 */
function assertUnlocked(
  user: User,
  lessonId: string,
  stored: learnProgress.StoredProgress,
  language: Parameters<typeof getContent>[0],
): void {
  const screen = buildLearn({
    user,
    now: new Date(),
    progress: learnProgress.asProgress(stored),
    language: language ?? 'en',
  });

  const state = screen.lessons.find((lesson) => lesson.id === lessonId)?.state;
  if (state === 'locked') {
    throw new ApiError('FORBIDDEN', 'that lesson is not unlocked yet', { lessonId });
  }
}

/**
 * `GET /v1/content/curriculum/pdf` — the takeaway (iOS ADR-0019).
 *
 * **Authenticated but cacheable**, and the combination is deliberate: the bytes depend on the language and
 * the reader's display currency and on nothing else, so two readers with the same pair get the same
 * document. It carries a `Vary` on both, an ETag derived from the content version plus the currency, and a
 * long `max-age` — the content only changes with a deploy.
 *
 * A session is still required because the route is not anonymous content: the currency comes from the user
 * document, and there is no sensible answer without one.
 */
learnRoutes.get('/v1/content/curriculum/pdf', requireSession(), async (c) => {
  const language = resolveLanguage(c.req.header('accept-language'));
  const currency = c.var.user.displayCurrency;
  const content = getContent(language);

  // Derived from the curriculum's own ETag plus the currency, so a content change or a currency change
  // invalidates it and nothing else does.
  const etag = `"${createHash('sha256')
    .update(`${content.curriculum.etag}:${currency}:pdf`)
    .digest('hex')
    .slice(0, 32)}"`;

  const headers = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="hisaabwise-curriculum.pdf"',
    ETag: etag,
    'Cache-Control': 'private, max-age=86400, must-revalidate',
    Vary: 'Accept-Language, Authorization',
  };

  if (c.req.header('if-none-match')?.includes(etag) === true) return c.body(null, 304, headers);

  const pdf = await renderPdf(language, currency);
  return c.body(new Uint8Array(pdf), 200, { ...headers, 'Content-Length': String(pdf.byteLength) });
});
