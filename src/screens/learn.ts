import { getContent, type Language } from '../content';
import {
  accuracyFor,
  currentStreak,
  lessonSequence,
  lessonStates,
  nextLesson,
  questionCount,
  unitUnlocked,
  type LessonState,
  type Progress,
} from '../domain/learn';
import { currencyToken, tokenGap } from '../domain/money';
import { dayKey } from '../domain/time';
import type { User } from '../repositories/users';

/**
 * `GET /v1/screens/learn` — **the per-user half of Learn** (ADR-0020, iOS ADR-0034).
 *
 * The streak, the XP, which lesson is next, every lesson's unlock state, and the two counts each progress
 * ring is drawn from. The curriculum itself comes from `GET /v1/curriculum`, and the client joins the two
 * **by lesson id**.
 *
 * That is not an exception to "one read per screen" — it is invariant 8 deciding where the seam goes. The
 * curriculum is the same 100 KB for everybody and is stored with an ETag; everything here is per-user and
 * bypasses every cache. Folding them together would make the curriculum uncacheable.
 */

/** A stat with its display string and its VoiceOver label — the client prints all three verbatim. */
export interface Stat {
  readonly value: number;
  readonly display: string;
  readonly accessibilityLabel: string;
}

const digits = new Intl.NumberFormat('en-US');

const streakStat = (value: number): Stat => ({
  value,
  display: digits.format(value),
  // "No streak yet" rather than "0-day streak": a screen reader should say what it means, and the design's
  // own copy makes the zero case a sentence rather than a number.
  accessibilityLabel: value === 0 ? 'No streak yet' : `${String(value)}-day streak`,
});

const xpStat = (value: number): Stat => ({
  value,
  display: digits.format(value),
  accessibilityLabel:
    value === 0 ? 'No experience points yet' : `${digits.format(value)} experience points`,
});

/**
 * The label under a lesson's ring.
 *
 * Server-owned because the client prints it verbatim, and because the pluralisation and the three branches
 * are content decisions rather than layout ones.
 */
export function progressLabelFor(
  state: LessonState,
  segments: number,
  filled: number,
  done: { correct: number; total: number } | undefined,
): string {
  if (state === 'locked') return 'Locked until you finish the lesson before it';

  if (state === 'completed' && done !== undefined) {
    if (done.correct === done.total) return `Completed, all ${String(done.total)} questions right`;
    return `Completed, ${String(done.correct)} of ${String(done.total)} questions right`;
  }

  if (filled === 0) return `Not started, ${String(segments)} questions`;
  return `${String(filled)} of ${String(segments)} questions answered`;
}

export interface LearnPayload {
  readonly streak: Stat;
  readonly xp: Stat;
  readonly currencyToken: string;
  readonly nextLesson?: { unitId: string; lessonId: string; title: string };
  readonly units: { id: string; isUnlocked: boolean }[];
  readonly lessons: {
    id: string;
    state: LessonState;
    segments: number;
    filledSegments: number;
    progressLabel: string;
  }[];
}

export interface LearnInput {
  readonly user: User;
  readonly now: Date;
  readonly progress: Progress;
  readonly language: Language;
}

/**
 * Build the Learn payload.
 *
 * `filledSegments` is the interesting field. For a completed lesson it is the number answered **correctly**,
 * so the ring shows how well it went rather than merely that it happened; for one in progress it is the
 * stored step position translated into questions answered. The client is given the count rather than being
 * asked to derive it, which is the same rule every other screen follows.
 */
export function buildLearn(input: LearnInput): LearnPayload {
  const { user, now, progress, language } = input;
  const curriculum = getContent(language).curriculum.value;
  const today = dayKey(now, user.timezone);

  const states = lessonStates(curriculum, progress.done);
  const unlocked = unitUnlocked(curriculum, progress.done);
  const next = nextLesson(curriculum, progress.done);
  const token = currencyToken(user.displayCurrency);

  return {
    // Evaluated lazily against the stored day key, so a device-clock change cannot move it and no nightly
    // job is needed (Product Spec §4.4).
    streak: streakStat(currentStreak(progress.streak, progress.lastActiveDayKey, today)),
    xp: xpStat(progress.xp),
    currencyToken: `${token}${tokenGap(token)}`,

    // Absent once every lesson is done — the client's field is optional, and "next" has no meaning then.
    ...(next === undefined
      ? {}
      : { nextLesson: { unitId: next.unitId, lessonId: next.lesson.id, title: next.lesson.title } }),

    units: curriculum.units.map((unit) => ({
      id: unit.id,
      isUnlocked: unlocked.get(unit.id) ?? false,
    })),

    lessons: lessonSequence(curriculum).map(({ lesson }) => {
      const state = states.get(lesson.id) ?? 'locked';
      const segments = questionCount(lesson);
      const done = progress.done[lesson.id];

      const filledSegments =
        state === 'completed'
          ? (done?.correct ?? segments)
          : questionsAnsweredBy(lesson.steps.length, segments, progress.progress[lesson.id]);

      return {
        id: lesson.id,
        state,
        segments,
        filledSegments,
        progressLabel: progressLabelFor(state, segments, filledSegments, done),
      };
    }),
  };
}

/**
 * How many questions a stored step position implies.
 *
 * The stored position is a **step** index, and a lesson interleaves teach pages with questions, so it has
 * to be translated. Bounded by the question count so a stale position from an edited curriculum cannot
 * overfill a ring.
 */
function questionsAnsweredBy(
  totalSteps: number,
  questions: number,
  stepIndex: number | undefined,
): number {
  if (stepIndex === undefined || stepIndex <= 0 || totalSteps === 0) return 0;
  return Math.min(questions, Math.round((stepIndex / totalSteps) * questions));
}

// ── The completion payload ────────────────────────────────────────────────────────────────────

/** The seven-day strip, Sunday first, as the design has it. */
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export interface WeekDay {
  readonly label: string;
  readonly isComplete: boolean;
  readonly isToday: boolean;
  readonly accessibilityLabel: string;
}

/**
 * The week strip, built in the reader's timezone.
 *
 * The design reads `new Date().getDay()` in the browser, which puts "today" in the wrong column for anyone
 * whose local day differs from the device's idea of it — the same defect as the date labels (D5). Here the
 * week is derived from the reader's own day keys.
 */
export function weekStrip(activeDayKeys: readonly string[], todayDayKey: string): WeekDay[] {
  const active = new Set(activeDayKeys);
  const [year = 0, month = 1, day = 1] = todayDayKey.split('-').map(Number);
  const todayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return WEEKDAYS.map((label, index) => {
    // The Sunday-anchored week containing today.
    const offset = index - todayIndex;
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    const key = date.toISOString().slice(0, 10);
    const isComplete = active.has(key);
    const isToday = index === todayIndex;

    return {
      label,
      isComplete,
      isToday,
      accessibilityLabel: `${isToday ? 'Today' : (WEEKDAY_NAMES[index] ?? label)}, ${
        isComplete ? 'lesson finished' : 'nothing finished'
      }`,
    };
  });
}

export interface CompletionPayload {
  readonly isFirstCompletion: boolean;
  readonly xpEarned: Stat;
  readonly accuracy: Stat;
  readonly streakLine: string;
  readonly week: WeekDay[];
  readonly screen: LearnPayload;
}

export function buildCompletion(input: {
  isFirstCompletion: boolean;
  xpAwarded: number;
  correct: number;
  total: number;
  streak: number;
  streakGrew: boolean;
  activeDayKeys: readonly string[];
  todayDayKey: string;
  screen: LearnPayload;
}): CompletionPayload {
  const accuracy = accuracyFor(input.correct, input.total);

  return {
    isFirstCompletion: input.isFirstCompletion,
    xpEarned: {
      value: input.xpAwarded,
      // `+50` on an award, a bare `0` on a replay — the plus is a celebration and there is nothing to
      // celebrate the second time.
      display: input.xpAwarded > 0 ? `+${String(input.xpAwarded)}` : '0',
      accessibilityLabel:
        input.xpAwarded > 0
          ? `${String(input.xpAwarded)} experience points earned`
          : 'No experience points earned',
    },
    accuracy: {
      value: accuracy,
      display: `${String(accuracy)}%`,
      accessibilityLabel: `${String(accuracy)} percent accuracy`,
    },
    streakLine: input.streakGrew
      ? `Your streak just grew to ${String(input.streak)} days. Come back tomorrow and keep it alive.`
      : 'You have already learned something today — that is how this compounds.',
    week: weekStrip(input.activeDayKeys, input.todayDayKey),
    screen: input.screen,
  };
}
