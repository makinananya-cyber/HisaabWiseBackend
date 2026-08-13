/**
 * Compares a live response against a fixture's *shape*.
 *
 * Figures are not asserted — a fixture's `553900` is one seeded user's data. What is asserted is
 * everything the client's `Decodable` conformances actually depend on:
 *
 *  - every key the fixture has is present (a missing key fails Swift's generated initialiser)
 *  - the JSON type of each value matches
 *  - `Money` objects satisfy their own invariants, because iOS ADR-0003 removed the client's
 *    formatter: `minor` must be an integer, `display` must be a non-empty string. A blank
 *    `display` is exactly the `budget-drifted.json` failure case, so it must not pass
 *
 * Extra keys in the response are allowed: Swift's decoder ignores them, so adding one is a
 * backwards-compatible change. Removing one is not.
 *
 * A `null` in the fixture marks the field optional — `home-inr.json` carries
 * `"remaining": null` — so a live response may send a value or null there.
 */

export interface ShapeProblem {
  path: string;
  problem: string;
}

const moneyKeys = ['minor', 'currency', 'exponent'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && moneyKeys.every((key) => key in value);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkMoney(actual: unknown, path: string, problems: ShapeProblem[]): void {
  if (!isRecord(actual)) {
    problems.push({ path, problem: `expected a Money object, got ${jsonType(actual)}` });
    return;
  }

  const { minor, currency, exponent, display } = actual;

  if (typeof minor !== 'number' || !Number.isInteger(minor)) {
    problems.push({
      path: `${path}.minor`,
      problem: `must be an integer count of the smallest unit, got ${JSON.stringify(minor)}`,
    });
  }
  if (typeof currency !== 'string' || currency.length !== 3) {
    problems.push({
      path: `${path}.currency`,
      problem: `must be a 3-letter code, got ${JSON.stringify(currency)}`,
    });
  }
  if (typeof exponent !== 'number' || !Number.isInteger(exponent) || exponent < 0 || exponent > 3) {
    problems.push({
      path: `${path}.exponent`,
      problem: `must be 0–3, got ${JSON.stringify(exponent)}`,
    });
  }
  // The client has no formatter to fall back on, so an empty display string is a broken payload
  // rather than a cosmetic problem.
  if (typeof display !== 'string' || display.trim() === '') {
    problems.push({
      path: `${path}.display`,
      problem: `must be a non-empty formatted string — the client has no formatter (iOS ADR-0003), got ${JSON.stringify(display)}`,
    });
  }
}

function walk(expected: unknown, actual: unknown, path: string, problems: ShapeProblem[]): void {
  // A null in the fixture marks the field optional; anything is acceptable there.
  if (expected === null) return;

  if (isMoney(expected)) {
    checkMoney(actual, path, problems);
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      problems.push({ path, problem: `expected an array, got ${jsonType(actual)}` });
      return;
    }
    if (expected.length === 0) return;

    // Fixture arrays are genuinely heterogeneous, so the first element is not a template for the
    // rest. Three real cases in the corpus:
    //
    //  - `expenses.categories` is a discriminated union on `kind`: `log` rows carry `entries` and
    //    `entryCountLabel`, `lines` rows carry `lines`, `fixed` rows carry neither, and only some
    //    carry `field`.
    //  - `split.segments` omits `target` on the `surplus` segment, which has no target.
    //  - `account.rows` omits `value` on rows that display none.
    //
    // So every actual element must satisfy *at least one* variant the fixture demonstrates. When
    // none matches, the closest variant's problems are reported — the most useful diagnosis.
    actual.forEach((element, index) => {
      const elementPath = `${path}[${String(index)}]`;
      let closest: ShapeProblem[] | undefined;

      for (const variant of expected) {
        const candidate: ShapeProblem[] = [];
        walk(variant, element, elementPath, candidate);
        if (candidate.length === 0) return;
        if (closest === undefined || candidate.length < closest.length) closest = candidate;
      }

      if (closest !== undefined) problems.push(...closest);
    });
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      problems.push({ path, problem: `expected an object, got ${jsonType(actual)}` });
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (!(key in actual)) {
        problems.push({ path: childPath, problem: 'missing — the client requires this key' });
        continue;
      }
      walk(value, actual[key], childPath, problems);
    }
    return;
  }

  if (jsonType(expected) !== jsonType(actual)) {
    problems.push({
      path,
      problem: `expected ${jsonType(expected)}, got ${jsonType(actual)}`,
    });
  }
}

/** Every way `actual` fails to satisfy the contract `expected` describes. Empty means it passes. */
export function shapeProblems(expected: unknown, actual: unknown): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  walk(expected, actual, '', problems);
  return problems;
}

/** Throws with every problem listed, so one run gives one complete answer. */
export function assertMatchesShape(expected: unknown, actual: unknown, label: string): void {
  const problems = shapeProblems(expected, actual);
  if (problems.length === 0) return;

  throw new Error(
    `${label} does not satisfy the client contract:\n` +
      problems.map(({ path, problem }) => `  ${path || '(root)'}: ${problem}`).join('\n'),
  );
}
