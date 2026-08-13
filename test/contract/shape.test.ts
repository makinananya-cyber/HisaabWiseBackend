import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { shapeProblems } from './shape';

const corpusDir = path.join(import.meta.dirname, 'corpus');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(corpusDir, name), 'utf8'));
}

/**
 * The harness checks itself.
 *
 * An assertion helper nobody tests is worse than no assertion at all — it turns every later slice
 * green for the wrong reason. So: real fixtures must pass, and each way a payload can break the
 * client must actually be caught.
 */
describe('shape checking', () => {
  const realFixtures = [
    'home-inr.json',
    'home-first-run.json',
    'expenses-inr.json',
    'expenses-over-budget.json',
    'reports-inr.json',
    'reports-month-inr.json',
    'reports-month-aed.json',
    'reports-empty.json',
    'account-inr.json',
    'learn-in-progress.json',
    'budget-inr.json',
    'money-exponents.json',
    'me-verified.json',
    'session-tokens.json',
  ];

  it.each(realFixtures)('%s satisfies its own shape', (name) => {
    expect(shapeProblems(fixture(name), fixture(name))).toEqual([]);
  });

  it('catches a missing key, which fails the client decoder', () => {
    const expected = { savings: { saved: 1, goal: 2 } };
    const actual = { savings: { saved: 1 } };

    expect(shapeProblems(expected, actual)).toEqual([
      { path: 'savings.goal', problem: 'missing — the client requires this key' },
    ]);
  });

  it('tolerates an extra key, because the Swift decoder ignores it', () => {
    expect(shapeProblems({ a: 1 }, { a: 1, addedLater: true })).toEqual([]);
  });

  it('catches a changed type', () => {
    const problems = shapeProblems({ shareLabel: '54%' }, { shareLabel: 0.54 });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain('expected string, got number');
  });

  // This is the case iOS ADR-0027 built `budget-drifted.json` for: a blank display string is
  // refused by Money's own guard, because the client deleted its formatter (ADR-0003).
  it('refuses a blank Money display string — the drifted-payload case', () => {
    const problems = shapeProblems(fixture('budget-inr.json'), fixture('budget-drifted.json'));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.path.endsWith('.display'))).toBe(true);
  });

  it('refuses a non-integer minor unit — money must never be a float', () => {
    const expected = { amount: { minor: 500, currency: 'AED', exponent: 2, display: 'AED 5' } };
    const actual = { amount: { minor: 5.5, currency: 'AED', exponent: 2, display: 'AED 5' } };

    expect(shapeProblems(expected, actual).some((p) => p.path === 'amount.minor')).toBe(true);
  });

  it('refuses a bad currency code, so an unknown code cannot pass as USD', () => {
    const expected = { amount: { minor: 500, currency: 'AED', exponent: 2, display: 'AED 5' } };
    const actual = { amount: { minor: 500, currency: 'XX', exponent: 2, display: 'AED 5' } };

    expect(shapeProblems(expected, actual).some((p) => p.path === 'amount.currency')).toBe(true);
  });

  it('checks every element of an array, not just the first', () => {
    const expected = { rows: [{ id: 'a', label: 'A' }] };
    const actual = { rows: [{ id: 'a', label: 'A' }, { id: 'b' }] };

    expect(shapeProblems(expected, actual)).toEqual([
      { path: 'rows[1].label', problem: 'missing — the client requires this key' },
    ]);
  });

  it('treats a null in the fixture as optional, since home-inr.json carries one', () => {
    expect(shapeProblems({ remaining: null }, { remaining: { minor: 1 } })).toEqual([]);
    expect(shapeProblems({ remaining: null }, { remaining: null })).toEqual([]);
  });

  it('reports every problem at once rather than the first', () => {
    const expected = { a: 'x', b: 'y', c: 'z' };

    expect(shapeProblems(expected, { a: 1, b: 2 })).toHaveLength(3);
  });
});
