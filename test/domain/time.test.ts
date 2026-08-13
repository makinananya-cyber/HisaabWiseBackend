import { describe, expect, it } from 'vitest';

import {
  ageInYears,
  calendarDate,
  dayKey,
  daysBetween,
  isValidTimezone,
  monthKey,
  nextMonthKey,
  previousMonthKey,
} from '../../src/domain/time';
import { required } from '../support/expect';

/**
 * Day boundaries, in the user's stored zone (invariant 6).
 *
 * The offsets tested here are chosen from the target market rather than from a list of interesting cases:
 * **Asia/Dubai** is +04:00, **Asia/Kolkata** +05:30, **Asia/Kathmandu** +05:45. The half- and
 * quarter-hour offsets are why "compute the day by adding hours to a UTC timestamp" is wrong here and not
 * merely inelegant — a large fraction of this app's users live at one.
 */

describe('dayKey', () => {
  it('gives the local calendar date, not the UTC one', () => {
    // 20:30 UTC on 14 August is already the 15th in Dubai (+04:00).
    const instant = new Date('2026-08-14T20:30:00Z');

    expect(dayKey(instant, 'UTC')).toBe('2026-08-14');
    expect(dayKey(instant, 'Asia/Dubai')).toBe('2026-08-15');
  });

  it('is correct at a half-hour offset', () => {
    // 18:45 UTC is 00:15 on the 15th in Kolkata (+05:30) — the same instant, a different date.
    const instant = new Date('2026-08-14T18:45:00Z');

    expect(dayKey(instant, 'Asia/Kolkata')).toBe('2026-08-15');
    expect(dayKey(instant, 'Asia/Dubai')).toBe('2026-08-14');
  });

  it('is correct at a quarter-hour offset', () => {
    // Kathmandu is +05:45. At 18:20 UTC it is 00:05 on the 15th there and still the 14th in Kolkata.
    const instant = new Date('2026-08-14T18:20:00Z');

    expect(dayKey(instant, 'Asia/Kathmandu')).toBe('2026-08-15');
    expect(dayKey(instant, 'Asia/Kolkata')).toBe('2026-08-14');
  });

  it('follows a DST transition rather than a fixed offset', () => {
    // London is +01:00 in August and +00:00 in January. A fixed-offset implementation gets one of these
    // wrong, which is the twice-a-year bug this exists to avoid.
    expect(dayKey(new Date('2026-08-14T23:30:00Z'), 'Europe/London')).toBe('2026-08-15');
    expect(dayKey(new Date('2026-01-14T23:30:00Z'), 'Europe/London')).toBe('2026-01-14');
  });

  it('handles a negative offset', () => {
    expect(dayKey(new Date('2026-08-15T03:00:00Z'), 'America/New_York')).toBe('2026-08-14');
  });
});

describe('monthKey', () => {
  it('is the local month, so a month boundary moves with the zone', () => {
    // 31 July, 21:00 UTC is already August in Kolkata. This is exactly the case the rollover job has to
    // get right, and why it runs every 15 minutes rather than hourly.
    const instant = new Date('2026-07-31T21:00:00Z');

    expect(monthKey(instant, 'UTC')).toBe('2026-07');
    expect(monthKey(instant, 'Asia/Kolkata')).toBe('2026-08');
  });
});

describe('month arithmetic', () => {
  it('steps back across a year boundary', () => {
    expect(previousMonthKey('2026-01')).toBe('2025-12');
    expect(previousMonthKey('2026-08')).toBe('2026-07');
  });

  it('steps forward across a year boundary', () => {
    expect(nextMonthKey('2026-12')).toBe('2027-01');
    expect(nextMonthKey('2026-01')).toBe('2026-02');
  });

  it('pads single-digit months, so keys sort lexicographically', () => {
    expect(nextMonthKey('2026-08')).toBe('2026-09');
    expect(previousMonthKey('2026-10')).toBe('2026-09');
    // Lexicographic sorting of month keys is relied on by the archive queries.
    expect(['2026-10', '2026-09', '2026-01'].sort()).toEqual(['2026-01', '2026-09', '2026-10']);
  });

  it('round-trips', () => {
    for (const key of ['2025-12', '2026-01', '2026-02', '2026-08', '2026-12']) {
      expect(previousMonthKey(nextMonthKey(key))).toBe(key);
    }
  });
});

describe('daysBetween', () => {
  it('counts whole days from the keys, not from the instants', () => {
    expect(daysBetween('2026-08-14', '2026-08-15')).toBe(1);
    expect(daysBetween('2026-08-14', '2026-08-14')).toBe(0);
    expect(daysBetween('2026-08-15', '2026-08-14')).toBe(-1);
  });

  it('crosses a month and a year boundary', () => {
    expect(daysBetween('2026-07-31', '2026-08-01')).toBe(1);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('is unaffected by DST, because both keys are already local', () => {
    // 29 March 2026 is a spring-forward day in Europe/London. A 23-hour day is still one day.
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('handles a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('ageInYears', () => {
  const dob = required(calendarDate('2013-08-15'), 'a date of birth of 2013-08-15');

  it('is one year less the day before a birthday', () => {
    expect(ageInYears(dob, new Date('2026-08-14T12:00:00Z'), 'Asia/Dubai')).toBe(12);
  });

  it('turns over on the birthday itself', () => {
    expect(ageInYears(dob, new Date('2026-08-15T12:00:00Z'), 'Asia/Dubai')).toBe(13);
  });

  it('turns over on the birthday in the user\'s zone, not in UTC', () => {
    // 21:00 UTC on the 14th is already the 15th in Dubai, so the 13+ gate opens there first. Computing
    // this in UTC would refuse a user who is 13 where they are standing.
    const instant = new Date('2026-08-14T21:00:00Z');

    expect(ageInYears(dob, instant, 'Asia/Dubai')).toBe(13);
    expect(ageInYears(dob, instant, 'UTC')).toBe(12);
  });
});

describe('calendarDate', () => {
  it('reads a YYYY-MM-DD as UTC midnight, because a birthday has no timezone', () => {
    expect(calendarDate('2013-08-15')?.toISOString()).toBe('2013-08-15T00:00:00.000Z');
  });

  it('refuses a date that does not exist', () => {
    // `Date.UTC` would roll this forward to 2 March, silently storing a different birthday.
    expect(calendarDate('2026-02-30')).toBeNull();
    expect(calendarDate('2026-13-01')).toBeNull();
    expect(calendarDate('2026-00-10')).toBeNull();
  });

  it('accepts a real leap day and refuses a fake one', () => {
    expect(calendarDate('2028-02-29')).not.toBeNull();
    expect(calendarDate('2026-02-29')).toBeNull();
  });

  it('refuses anything that is not the expected shape', () => {
    for (const value of ['15/08/2013', '2013-8-15', '2013-08-15T00:00:00Z', '', 'yesterday']) {
      expect(calendarDate(value), value).toBeNull();
    }
  });
});

describe('isValidTimezone', () => {
  it('accepts the zones this market actually uses', () => {
    for (const zone of ['Asia/Dubai', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Karachi', 'Asia/Manila', 'UTC']) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
  });

  it('accepts a legacy alias, because that is what devices actually send', () => {
    // A whitelist of canonical names would refuse both of these, and `Asia/Kolkata` is what an iOS
    // device in the target market reports.
    expect(isValidTimezone('Asia/Calcutta')).toBe(true);
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
  });

  it('refuses an offset, which Intl would otherwise accept', () => {
    // The gap this closes: since ES2021 `Intl` accepts offset forms, and storing one would freeze a
    // user's DST behaviour at the moment they signed in — an hour out for half the year, silently.
    for (const zone of ['+04:00', '-05:00', '+0400', 'GMT+4', 'UTC-3']) {
      expect(isValidTimezone(zone), zone).toBe(false);
    }
  });

  it('refuses a made-up name and an empty string', () => {
    for (const zone of ['Mars/Olympus', 'Asia/Atlantis', '']) {
      expect(isValidTimezone(zone), zone).toBe(false);
    }
  });
});
