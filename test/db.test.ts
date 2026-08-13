import { describe, expect, it } from 'vitest';

import { getDb, getMongoClient, retryDelays } from '../src/db';

/**
 * The retry *policy* is tested here, purely. The connection attempt itself is not: against an
 * unreachable host each attempt costs the full server-selection timeout, so asserting the schedule
 * through real connections would make this suite slow enough that someone eventually deletes it —
 * and a deleted gate is worse than a narrow one.
 *
 * That the retry works end to end is verified where it matters: booting against the real cluster,
 * where attempt 1 timed out, attempt 2 succeeded, and the server came up. See the README's
 * observed-platform-facts table.
 */
describe('retryDelays', () => {
  it('produces one wait per gap between attempts, not one per attempt', () => {
    expect(retryDelays(3, 500)).toHaveLength(2);
    expect(retryDelays(1, 500)).toEqual([]);
  });

  it('doubles the delay, so a struggling cluster is not hammered', () => {
    expect(retryDelays(4, 10)).toEqual([10, 20, 40]);
  });

  it('caps at 8s, so a long chain cannot stall a deploy indefinitely', () => {
    expect(retryDelays(5, 4_000)).toEqual([4_000, 8_000, 8_000, 8_000]);
  });

  it('handles a zero or negative attempt count without producing waits', () => {
    expect(retryDelays(0, 500)).toEqual([]);
    expect(retryDelays(-1, 500)).toEqual([]);
  });

  // The default schedule the entrypoint uses: five attempts over about 7.5s of waiting, on top of
  // the connect time itself. Long enough to ride out the observed intermittent reset, short enough
  // that a genuinely dead cluster fails a deploy promptly rather than hanging a rollout.
  it('gives the boot path roughly seven and a half seconds of patience', () => {
    const schedule = retryDelays(5, 500);

    expect(schedule).toEqual([500, 1_000, 2_000, 4_000]);
    expect(schedule.reduce((total, ms) => total + ms, 0)).toBe(7_500);
  });
});

describe('using the database before it is connected', () => {
  it('raises a programming error rather than handing back something unusable', () => {
    // A half-connected handle would be worse than none: a caller would get something that silently
    // never works, instead of a failure naming the mistake.
    expect(() => getMongoClient()).toThrow(/has not been connected/);
    expect(() => getDb()).toThrow(/has not been connected/);
  });
});
