/**
 * Day and month boundaries, computed in the user's **stored IANA timezone** (invariant 6).
 *
 * **Never UTC, and never the device clock.** Every day-shaped fact in this system depends on this
 * module: the streak, the "Today / Yesterday / N days ago" labels, which month an expense files into,
 * and when the rollover job archives a month. The zone is captured from the device at registration,
 * login and refresh (ADR-0023) and then *stored* — so a user who changes their phone's clock cannot
 * move a streak, because nothing here reads a clock the client controls.
 *
 * The target market makes the half-hour offsets load-bearing rather than academic: Asia/Kolkata is
 * +05:30 and Asia/Kathmandu +05:45, and both are squarely in it. Anything that assumed whole hours
 * would file a late-evening expense into the wrong day for a large fraction of users.
 *
 * Pure, and tested at whole-hour, half-hour and quarter-hour offsets without a database (ADR-0014).
 */

/**
 * Whether a string is a **named** timezone this runtime knows.
 *
 * `Intl` alone is not enough, and the gap is not academic: since ES2021 it also accepts *offset* forms
 * like `+04:00`, and storing one of those would freeze a user's DST behaviour at the moment they signed
 * in — the app would be an hour out for half the year, silently, for exactly the users who travel. So an
 * offset is refused structurally before `Intl` is consulted.
 *
 * A whitelist was the obvious alternative and is wrong here: `Intl.supportedValuesOf('timeZone')` returns
 * canonical names only, which excludes both `UTC` and `Asia/Kolkata` — and `Asia/Kolkata` is precisely
 * what an iOS device in the target market reports. Checking the *shape* and letting `Intl` decide
 * existence accepts every alias a real device sends while still refusing an offset.
 */
export function isValidTimezone(timezone: string): boolean {
  // `+04:00`, `-0500`, `GMT+4`, `UTC-3` — a zone's value today, not a zone.
  if (/^[+-]/.test(timezone) || /^(GMT|UTC)[+-]/i.test(timezone) || timezone.includes(':')) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * `Intl.DateTimeFormat` instances are expensive to construct and are constructed per day-key lookup on
 * hot paths — a month of expenses is one per entry. Cached per zone, which is a handful of entries in
 * practice and bounded by the number of zones the users of one process actually have.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The local calendar date, as `YYYY-MM-DD`.
 *
 * Via `Intl` rather than by adding an offset to a timestamp, because an offset is not a constant: it
 * changes at a DST transition, and the arithmetic that ignores that produces a wrong day exactly twice a
 * year. `en-CA` is used because its short date format *is* ISO order, so no reassembly is needed.
 *
 * @throws {RangeError} for a zone this runtime does not know. Callers hold a stored zone that was
 * validated on the way in, so reaching this is a data-integrity problem rather than a user error.
 */
export const dayKey = (instant: Date, timezone: string): string =>
  formatterFor(timezone).format(instant);

/** The local month, as `YYYY-MM`. What an expense files into, and what the rollover archives. */
export const monthKey = (instant: Date, timezone: string): string =>
  dayKey(instant, timezone).slice(0, 7);

/**
 * Split a key into its numeric parts.
 *
 * Explicit rather than a destructured `split().map(Number)`, because `noUncheckedIndexedAccess` is on and
 * it is right to be: a malformed key reaching here silently produces `NaN` arithmetic, and a month key of
 * `NaN-NaN` would be written to an archive document.
 */
function parts(key: string): number[] {
  const values = key.split('-').map(Number);
  if (values.some((value) => !Number.isInteger(value))) {
    throw new RangeError(`not a date or month key: ${JSON.stringify(key)}`);
  }
  return values;
}

const monthParts = (key: string): { year: number; month: number } => {
  const [year, month] = parts(key);
  if (year === undefined || month === undefined) throw new RangeError(`not a month key: ${key}`);
  return { year, month };
};

/** The month key before a given one, so `2026-01` yields `2025-12`. */
export function previousMonthKey(key: string): string {
  const { year, month } = monthParts(key);
  if (month === 1) return `${String(year - 1)}-12`;
  return `${String(year)}-${String(month - 1).padStart(2, '0')}`;
}

/** The month key after a given one. Used by the rollover to advance the live month. */
export function nextMonthKey(key: string): string {
  const { year, month } = monthParts(key);
  if (month === 12) return `${String(year + 1)}-01`;
  return `${String(year)}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Whole days between two day keys, `later - earlier`.
 *
 * Computed from the keys rather than from the instants they came from, which is the point: two
 * timestamps 20 hours apart may be the same local day or two days apart, and it is the *keys* that
 * decide. `Date.UTC` is used purely as a calendar calculator here — both keys are already local, so
 * treating them as UTC midnights makes the subtraction exact and DST-free.
 */
export function daysBetween(earlier: string, later: string): number {
  const asUTC = (key: string): number => {
    const [year, month, day] = parts(key);
    if (year === undefined || month === undefined || day === undefined) {
      throw new RangeError(`not a day key: ${key}`);
    }
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((asUTC(later) - asUTC(earlier)) / 86_400_000);
}

/**
 * `"Today"`, `"Yesterday"`, `"3 days ago"` — the label beside a logged expense.
 *
 * **The server owns this, and that is the point.** The design writes it in the browser from the device
 * clock, which is defect D5's shape: two devices in different zones disagree about which entries are
 * "today", and a user who changes their clock relabels their history. Here it is computed from two day
 * keys in the *stored* zone, so it is the same answer for the same entry however it is read.
 *
 * A future date reads as `"Today"` rather than `"in 2 days"`: entry dates are capped to the live month
 * and default to now, so a forward date means clock skew between the client's idea of now and the
 * server's — and "Today" is the least wrong thing to say about it.
 *
 * **Pure, so the copy is passed in, not read** (invariant: `time.ts` never touches content). The screen
 * builder hands its localised labels; the default keeps the English behaviour for direct callers and the
 * `{n}` token in `daysAgo` is where the day count lands.
 */
export interface RelativeDayLabels {
  readonly today: string;
  readonly yesterday: string;
  /** `"{n} days ago"` — `{n}` is replaced by the day count. */
  readonly daysAgo: string;
}

const ENGLISH_RELATIVE_DAY: RelativeDayLabels = {
  today: 'Today',
  yesterday: 'Yesterday',
  daysAgo: '{n} days ago',
};

export function relativeDayLabel(
  entryDayKey: string,
  todayDayKey: string,
  labels: RelativeDayLabels = ENGLISH_RELATIVE_DAY,
): string {
  const days = daysBetween(entryDayKey, todayDayKey);
  if (days <= 0) return labels.today;
  if (days === 1) return labels.yesterday;
  return labels.daysAgo.replace('{n}', String(days));
}

/**
 * How old an account holder must be.
 *
 * **The gate is `age < MINIMUM_AGE_YEARS`, so turning 16 today is old enough.** The client's date picker
 * has to agree with this exactly — it greys out every date that would fail — and the two disagreeing by a
 * day is a real defect this app has already had: the picker offered the sixteenth birthday as the newest
 * selectable date and then refused to select it, while the server would have accepted it.
 *
 * One number, exported, so the answer to "how old" lives in a single place a change can be made in.
 */
export const MINIMUM_AGE_YEARS = 16;

/**
 * Age in whole years on a given day, in the user's zone.
 *
 * For the ``MINIMUM_AGE_YEARS`` gate. Computed from the date of birth the user chose rather than from an
 * age they typed, because an age is a fact that changes without the server hearing about it.
 */
export function ageInYears(dob: Date, now: Date, timezone: string): number {
  const [birthYear = 0, birthMonth = 0, birthDay = 0] = parts(dayKey(dob, 'UTC'));
  const [year = 0, month = 0, day = 0] = parts(dayKey(now, timezone));

  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  return age;
}

/**
 * A `YYYY-MM-DD` date as a UTC midnight `Date`.
 *
 * Date of birth is a **calendar date, not an instant** — it has no timezone, and storing it as local
 * midnight in the user's zone would make it shift if they moved. UTC midnight is the conventional
 * canonical form, and `ageInYears` reads it back the same way.
 */
export function calendarDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects `2026-02-30`, which `Date.UTC` would silently roll forward to 2 March.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}
