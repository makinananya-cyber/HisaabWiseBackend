import type { Curriculum, Lesson, LessonStep } from '../content';
import { daysBetween } from './time';

/**
 * Learn's rules: XP, the streak, sequential unlocking, and what makes a submission impossible.
 *
 * **The client grades and the server re-grades** (invariant 10). Grading happens on the device because a
 * round trip per question would make a lesson feel slow, and that is safe only because every submission
 * carries one result per question and is recomputed here. A client-supplied XP figure is never stored.
 *
 * **What the server can and cannot verify, stated plainly.** The client submits
 * `{stepIndex, isCorrect}` per question — not the chosen answer — so the server cannot re-mark an
 * individual answer. What it *can* do, and does, is refuse a submission that could not have happened:
 * a step that is not a question, a step answered twice, a lesson whose predecessor is unfinished, a run
 * that used more than three hearts, or a completion that does not cover every question in the lesson.
 * That bounds a forged submission to "claimed to answer correctly what they actually got wrong", which
 * earns 20 XP over honesty and unlocks nothing that practice would not.
 *
 * Pure, and tested without a database (ADR-0014).
 */

// ── XP ────────────────────────────────────────────────────────────────────────────────────────

/**
 * 10 XP per correct answer, plus a 20 XP completion bonus.
 *
 * Transcribed from the prototype's own `run.xp += 10` and `const bonus = 20`, and it reproduces the
 * corpus exactly: `lesson-completed.json` earns 50 for 3 of 4 right (30 + 20), and
 * `learn-in-progress.json` holds 120 for two four-question lessons answered perfectly (2 × 60).
 */
export const XP_PER_CORRECT = 10;
export const XP_COMPLETION_BONUS = 20;

export const xpFor = (correct: number): number => correct * XP_PER_CORRECT + XP_COMPLETION_BONUS;

/** Three, as the prototype's `hearts: 3`. A fourth wrong answer ends the run. */
export const HEARTS = 3;

/**
 * Accuracy as a whole percent.
 *
 * **Derived on read, never stored.** `learn_progress.done` keeps `correct` and `total`; storing a rounded
 * accuracy would make it unrecomputable, and a stored 75% cannot later be reconciled against 3 of 4.
 */
export const accuracyFor = (correct: number, total: number): number =>
  total === 0 ? 0 : Math.round((correct / total) * 100);

// ── The curriculum, as a sequence ─────────────────────────────────────────────────────────────

/** Every question step in a lesson, with its index in the lesson's full step list. */
export function questionSteps(lesson: Lesson): { stepIndex: number; step: LessonStep }[] {
  return lesson.steps
    .map((step, stepIndex) => ({ stepIndex, step }))
    .filter(({ step }) => step.kind !== 'teach');
}

/** How many questions a lesson has — the ring's segment count. */
export const questionCount = (lesson: Lesson): number => questionSteps(lesson).length;

/**
 * Every lesson in curriculum order, with the unit it belongs to.
 *
 * **The flat order is what unlocking means**: a lesson is available when the one before it in this
 * sequence is done, across unit boundaries. Deriving it here rather than storing it means a curriculum
 * change cannot leave stale unlock state behind.
 */
export function lessonSequence(curriculum: Curriculum): { unitId: string; lesson: Lesson }[] {
  return curriculum.units.flatMap((unit) => unit.lessons.map((lesson) => ({ unitId: unit.id, lesson })));
}

// ── Progress ──────────────────────────────────────────────────────────────────────────────────

/** What the reader has done. The stored shape, minus the bookkeeping. */
export interface Progress {
  readonly xp: number;
  readonly streak: number;
  readonly lastActiveDayKey: string | null;
  /** Completed lessons: counts, not a rounded accuracy. Presence gates first-completion-only XP. */
  readonly done: Readonly<Record<string, { correct: number; total: number; xp: number }>>;
  /** Partial position within a lesson, so an interrupted run resumes. */
  readonly progress: Readonly<Record<string, number>>;
}

export type LessonState = 'completed' | 'available' | 'locked';

/**
 * Which lesson is unlocked, and what state each one is in.
 *
 * Sequential: the first lesson is always available, and every other is available once its predecessor is
 * completed. **Derived from `done` against the bundled curriculum, never stored** — so re-ordering a unit
 * or inserting a lesson cannot leave someone locked out of a lesson they had already reached.
 */
export function lessonStates(
  curriculum: Curriculum,
  done: Progress['done'],
): Map<string, LessonState> {
  const states = new Map<string, LessonState>();
  let previousCompleted = true;

  for (const { lesson } of lessonSequence(curriculum)) {
    const isDone = lesson.id in done;
    states.set(lesson.id, isDone ? 'completed' : previousCompleted ? 'available' : 'locked');
    previousCompleted = isDone;
  }

  return states;
}

/** A unit is unlocked once its first lesson is. */
export function unitUnlocked(curriculum: Curriculum, done: Progress['done']): Map<string, boolean> {
  const states = lessonStates(curriculum, done);
  return new Map(
    curriculum.units.map((unit) => [unit.id, states.get(unit.lessons[0]?.id ?? '') !== 'locked']),
  );
}

/** The next lesson to attempt, or `undefined` when every lesson is done. */
export function nextLesson(
  curriculum: Curriculum,
  done: Progress['done'],
): { unitId: string; lesson: Lesson } | undefined {
  return lessonSequence(curriculum).find(({ lesson }) => !(lesson.id in done));
}

// ── The streak ────────────────────────────────────────────────────────────────────────────────

/**
 * The streak as it stands **now**, evaluated lazily against the stored day key.
 *
 * **No nightly job, and that is the design rather than a shortcut** (Product Spec §4.4). A scheduled sweep
 * would be wrong for every timezone offset it did not run at, would drift if a run were skipped, and would
 * show a returning user a stale number until it reached them. Evaluating at read is correct for every
 * offset, cannot drift, is correct on the first read after a timezone change, and shows a lapsed user `0`
 * immediately.
 *
 * Today or yesterday keeps it; anything older is a lapse. **The prototype never reset it** — it incremented
 * after a six-month gap — so the reset is new behaviour.
 */
export function currentStreak(stored: number, lastActiveDayKey: string | null, todayDayKey: string): number {
  if (lastActiveDayKey === null) return 0;

  const gap = daysBetween(lastActiveDayKey, todayDayKey);
  // A negative gap means the stored day is in the future — a timezone move westward. The streak is kept
  // rather than reset: the reader did the work, and the clock moving under them is not their doing.
  if (gap <= 1) return stored;
  return 0;
}

/** The streak after finishing a lesson today, and whether that grew it. */
export function streakAfterCompletion(
  stored: number,
  lastActiveDayKey: string | null,
  todayDayKey: string,
): { streak: number; grew: boolean } {
  if (lastActiveDayKey === todayDayKey) {
    // Already learned today: the streak grows **once per day**, however many lessons are finished.
    return { streak: Math.max(stored, 1), grew: false };
  }

  const continuing = lastActiveDayKey !== null && daysBetween(lastActiveDayKey, todayDayKey) === 1;
  return { streak: continuing ? stored + 1 : 1, grew: true };
}

// ── Validating a submission ───────────────────────────────────────────────────────────────────

/** One question's outcome, as the client reports it. */
export interface SubmittedResult {
  readonly stepIndex: number;
  readonly isCorrect: boolean;
}

export type SubmissionProblem =
  | { readonly kind: 'unknownStep'; readonly stepIndex: number }
  | { readonly kind: 'notAQuestion'; readonly stepIndex: number }
  | { readonly kind: 'duplicateStep'; readonly stepIndex: number }
  | { readonly kind: 'heartsExhausted'; readonly wrong: number }
  | { readonly kind: 'incomplete'; readonly answered: number; readonly required: number };

/**
 * Everything wrong with a submission. Empty means it could have happened.
 *
 * @param requireEveryQuestion `true` for a completion, `false` for a mid-lesson progress report — a reader
 * who left after two of four questions is reporting a real position, not an incomplete claim.
 */
export function submissionProblems(
  lesson: Lesson,
  results: readonly SubmittedResult[],
  requireEveryQuestion: boolean,
): SubmissionProblem[] {
  const problems: SubmissionProblem[] = [];
  const questionIndices = new Set(questionSteps(lesson).map(({ stepIndex }) => stepIndex));
  const seen = new Set<number>();

  for (const result of results) {
    if (result.stepIndex < 0 || result.stepIndex >= lesson.steps.length) {
      problems.push({ kind: 'unknownStep', stepIndex: result.stepIndex });
      continue;
    }
    if (!questionIndices.has(result.stepIndex)) {
      // A teach page has no answer, so reporting one is either a client bug or an attempt to inflate a
      // lesson's question count.
      problems.push({ kind: 'notAQuestion', stepIndex: result.stepIndex });
      continue;
    }
    if (seen.has(result.stepIndex)) {
      problems.push({ kind: 'duplicateStep', stepIndex: result.stepIndex });
      continue;
    }
    seen.add(result.stepIndex);
  }

  const wrong = results.filter((result) => !result.isCorrect).length;
  if (wrong > HEARTS) {
    // A run that used a fourth heart ended; it cannot also have finished.
    problems.push({ kind: 'heartsExhausted', wrong });
  }

  if (requireEveryQuestion && seen.size !== questionIndices.size) {
    problems.push({ kind: 'incomplete', answered: seen.size, required: questionIndices.size });
  }

  return problems;
}

/** How many of a submission's answers were right, counted from the results rather than trusted. */
export const correctCount = (results: readonly SubmittedResult[]): number =>
  results.filter((result) => result.isCorrect).length;
