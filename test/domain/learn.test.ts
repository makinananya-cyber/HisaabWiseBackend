import { describe, expect, it } from 'vitest';

import { getContent, loadContent, type Lesson } from '../../src/content';
import {
  accuracyFor,
  correctCount,
  currentStreak,
  HEARTS,
  lessonSequence,
  lessonStates,
  nextLesson,
  questionCount,
  streakAfterCompletion,
  submissionProblems,
  unitUnlocked,
  XP_COMPLETION_BONUS,
  XP_PER_CORRECT,
  xpFor,
} from '../../src/domain/learn';
import { required } from '../support/expect';

loadContent();
const curriculum = getContent('en').curriculum.value;
const lessons = getContent('en').lessonById;

const lessonOf = (id: string): Lesson => required(lessons.get(id), `lesson ${id}`);

/** Every question in a lesson, answered correctly. */
const perfectRun = (lesson: Lesson): { stepIndex: number; isCorrect: boolean }[] =>
  lesson.steps
    .map((step, stepIndex) => ({ step, stepIndex }))
    .filter(({ step }) => step.kind !== 'teach')
    .map(({ stepIndex }) => ({ stepIndex, isCorrect: true }));

describe('XP', () => {
  /**
   * The design's own rule: `run.xp += 10` per correct answer and `const bonus = 20` on finish. It reproduces
   * the corpus exactly, which is the strongest evidence available that it is the intended rule —
   * `lesson-completed.json` earns 50 for 3 of 4 right, and `learn-in-progress.json` holds 120 for two
   * perfect four-question lessons.
   */
  it('is ten a correct answer plus a twenty completion bonus', () => {
    expect(XP_PER_CORRECT).toBe(10);
    expect(XP_COMPLETION_BONUS).toBe(20);
    expect(xpFor(3)).toBe(50);
    expect(xpFor(4)).toBe(60);
  });

  it('still pays the bonus for finishing with nothing right', () => {
    // Finishing is worth something on its own: the lesson was read even if the questions went badly.
    expect(xpFor(0)).toBe(20);
  });

  it('counts correct answers from the results rather than trusting a total', () => {
    expect(correctCount([{ stepIndex: 1, isCorrect: true }, { stepIndex: 3, isCorrect: false }])).toBe(1);
  });
});

describe('accuracy', () => {
  it('is a whole percent, derived rather than stored', () => {
    // A stored 75% can never be reconciled against 3 of 4, which is why `done` keeps the counts.
    expect(accuracyFor(3, 4)).toBe(75);
    expect(accuracyFor(4, 4)).toBe(100);
    expect(accuracyFor(0, 4)).toBe(0);
  });

  it('is zero rather than NaN for a lesson with no questions', () => {
    expect(accuracyFor(0, 0)).toBe(0);
  });
});

describe('the streak', () => {
  /**
   * Evaluated lazily at read (Product Spec §4.4). A nightly job would be wrong for every offset it did not
   * run at, would drift if a run were skipped, and would show a lapsed reader a stale number.
   */
  it('survives today and yesterday', () => {
    expect(currentStreak(4, '2026-08-13', '2026-08-13')).toBe(4);
    expect(currentStreak(4, '2026-08-12', '2026-08-13')).toBe(4);
  });

  it('resets after a missed day', () => {
    // The prototype never reset — it incremented after a six-month gap — so this is new behaviour.
    expect(currentStreak(4, '2026-08-11', '2026-08-13')).toBe(0);
    expect(currentStreak(40, '2026-02-01', '2026-08-13')).toBe(0);
  });

  it('is zero when nothing has ever been finished', () => {
    expect(currentStreak(0, null, '2026-08-13')).toBe(0);
    expect(currentStreak(9, null, '2026-08-13')).toBe(0);
  });

  it('is kept when the stored day is in the future', () => {
    // A reader who flew westward has a stored day ahead of their new local one. They did the work; the
    // clock moving under them is not their doing.
    expect(currentStreak(4, '2026-08-14', '2026-08-13')).toBe(4);
  });

  describe('after finishing a lesson', () => {
    it('grows by one when yesterday was active', () => {
      expect(streakAfterCompletion(4, '2026-08-12', '2026-08-13')).toEqual({ streak: 5, grew: true });
    });

    it('grows once per day, however many lessons are finished', () => {
      // The second lesson of the day earns XP but not a streak day.
      expect(streakAfterCompletion(5, '2026-08-13', '2026-08-13')).toEqual({ streak: 5, grew: false });
    });

    it('restarts at one after a lapse', () => {
      expect(streakAfterCompletion(9, '2026-08-01', '2026-08-13')).toEqual({ streak: 1, grew: true });
    });

    it('starts at one for a first-ever lesson', () => {
      expect(streakAfterCompletion(0, null, '2026-08-13')).toEqual({ streak: 1, grew: true });
    });
  });
});

describe('unlocking', () => {
  it('opens only the first lesson to a new reader', () => {
    const states = lessonStates(curriculum, {});

    expect(states.get('u1l1')).toBe('available');
    expect(states.get('u1l2')).toBe('locked');
    expect(states.get('u5l3')).toBe('locked');
  });

  it('opens the next lesson once its predecessor is done', () => {
    const states = lessonStates(curriculum, { u1l1: { correct: 4, total: 4, xp: 60 } });

    expect(states.get('u1l1')).toBe('completed');
    expect(states.get('u1l2')).toBe('available');
    expect(states.get('u1l3')).toBe('locked');
  });

  it('carries across a unit boundary', () => {
    // The sequence is flat: finishing a unit's last lesson opens the next unit's first.
    const sequence = lessonSequence(curriculum);
    const done = Object.fromEntries(
      sequence.slice(0, 3).map(({ lesson }) => [lesson.id, { correct: 4, total: 4, xp: 60 }]),
    );

    const states = lessonStates(curriculum, done);
    expect(states.get(required(sequence[3], 'the fourth lesson').lesson.id)).toBe('available');
  });

  it('unlocks a unit when its first lesson is open', () => {
    expect(unitUnlocked(curriculum, {}).get('u1')).toBe(true);
    expect(unitUnlocked(curriculum, {}).get('u2')).toBe(false);
  });

  it('names the next lesson, and nothing once every lesson is done', () => {
    expect(nextLesson(curriculum, {})?.lesson.id).toBe('u1l1');

    const all = Object.fromEntries(
      lessonSequence(curriculum).map(({ lesson }) => [lesson.id, { correct: 4, total: 4, xp: 60 }]),
    );
    expect(nextLesson(curriculum, all)).toBeUndefined();
  });

  it('has fifteen lessons in the sequence, matching the curriculum', () => {
    expect(lessonSequence(curriculum)).toHaveLength(15);
  });
});

describe('what makes a submission impossible', () => {
  const lesson = lessonOf('u1l1');

  it('accepts a complete, honest run', () => {
    expect(submissionProblems(lesson, perfectRun(lesson), true)).toEqual([]);
  });

  it('refuses a step index outside the lesson', () => {
    const problems = submissionProblems(lesson, [{ stepIndex: 999, isCorrect: true }], false);

    expect(problems.map((problem) => problem.kind)).toContain('unknownStep');
  });

  it('refuses a result naming a teach page', () => {
    // A teach page has no answer, so reporting one is either a client bug or an attempt to inflate a
    // lesson's question count.
    const teachIndex = lesson.steps.findIndex((step) => step.kind === 'teach');
    const problems = submissionProblems(lesson, [{ stepIndex: teachIndex, isCorrect: true }], false);

    expect(problems.map((problem) => problem.kind)).toContain('notAQuestion');
  });

  it('refuses a question answered twice', () => {
    const run = perfectRun(lesson);
    const first = required(run[0], 'the first question');
    const problems = submissionProblems(lesson, [...run, first], true);

    expect(problems.map((problem) => problem.kind)).toContain('duplicateStep');
  });

  it('refuses a run that used a fourth heart', () => {
    const run = perfectRun(lesson).map((result, index) => ({ ...result, isCorrect: index >= HEARTS + 1 }));

    // A run that exhausted its hearts ended; it cannot also have finished.
    const problems = submissionProblems(lesson, run, true);
    expect(problems.map((problem) => problem.kind)).toContain('heartsExhausted');
  });

  it('allows exactly three wrong answers', () => {
    const run = perfectRun(lesson).map((result, index) => ({ ...result, isCorrect: index >= HEARTS }));

    expect(submissionProblems(lesson, run, true).map((problem) => problem.kind)).not.toContain(
      'heartsExhausted',
    );
  });

  it('refuses a completion that skipped a question', () => {
    const partial = perfectRun(lesson).slice(0, -1);

    expect(submissionProblems(lesson, partial, true).map((problem) => problem.kind)).toContain('incomplete');
  });

  it('allows a partial run when completeness is not required', () => {
    // A reader who left after two of four questions is reporting a real position, not an incomplete claim.
    const partial = perfectRun(lesson).slice(0, 2);

    expect(submissionProblems(lesson, partial, false)).toEqual([]);
  });

  it('counts questions the same way the ring does', () => {
    for (const { lesson: candidate } of lessonSequence(curriculum)) {
      expect(questionCount(candidate)).toBe(perfectRun(candidate).length);
      expect(questionCount(candidate)).toBeGreaterThan(0);
    }
  });
});
