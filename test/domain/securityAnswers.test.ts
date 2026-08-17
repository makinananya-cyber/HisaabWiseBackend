import { describe, expect, it } from 'vitest';

import { answersMatch, isAnswerable, normaliseAnswer } from '../../src/domain/securityAnswers';

/**
 * The normaliser is the single highest-consequence pure function in this codebase.
 *
 * Security answers are the **entire** account-recovery mechanism — no email reset, no SMS — and the
 * stored form is a hash, so every tolerance the system offers has to be baked in here and applied
 * identically at registration and at verification. A change to this function silently locks out everyone
 * who registered before it: their stored hash is of the old canonical form, and nothing will ever produce
 * it again.
 *
 * So the tests below are in two halves, and both matter. **What must match** is the tolerance a real
 * person needs six months later. **What must not match** is the collision budget — every widening here
 * makes it easier to guess into somebody else's account.
 */

describe('what must match', () => {
  it('ignores case', () => {
    expect(answersMatch('Fluffy', 'fluffy')).toBe(true);
    expect(answersMatch('JAIPUR', 'Jaipur')).toBe(true);
  });

  it('ignores surrounding and internal whitespace', () => {
    expect(answersMatch('  New   Delhi  ', 'New Delhi')).toBe(true);
  });

  it('ignores accents, so a phone keyboard and a laptop agree', () => {
    expect(answersMatch('José', 'Jose')).toBe(true);
    expect(answersMatch('Zürich', 'Zurich')).toBe(true);
    expect(answersMatch('Cafés', 'cafes')).toBe(true);
  });

  it('ignores punctuation', () => {
    expect(answersMatch('St. Mary’s School', 'St Marys School')).toBe(true);
    expect(answersMatch('Toyota Corolla!', 'toyota corolla')).toBe(true);
  });

  it('accepts either apostrophe, because the keyboards produce different ones', () => {
    expect(answersMatch('Mary’s', "Mary's")).toBe(true);
  });

  it('ignores articles and the commonest prepositions', () => {
    expect(answersMatch('The Red House', 'Red House')).toBe(true);
    expect(answersMatch('School of Art', 'Art School')).toBe(true);
  });

  it('ignores word order, which is the deliberate widening', () => {
    // A person who remembers two words rarely remembers the order they typed them in. This accepts a
    // reordering they did not make, and that is the right trade for a mechanism whose failure mode is a
    // permanently locked account.
    expect(answersMatch('Mary Saint', 'Saint Mary')).toBe(true);
  });

  it('ignores a plural s on a longer word', () => {
    expect(answersMatch('cats', 'cat')).toBe(true);
    expect(answersMatch('The Beatles', 'beatle')).toBe(true);
  });

  it('ignores a single stray character, which a filter drops as noise', () => {
    expect(answersMatch('Fluffy x', 'Fluffy')).toBe(true);
  });
});

describe('what must not match', () => {
  it('refuses a genuinely different answer, even a close one', () => {
    // Levenshtein tolerance was deliberately dropped — it cannot be computed against a hash — so this is
    // the documented cost of the design, not an oversight.
    expect(answersMatch('Jaipur', 'Jodhpur')).toBe(false);
    expect(answersMatch('Fluffy', 'Fluffly')).toBe(false);
  });

  it('refuses a different word entirely', () => {
    expect(answersMatch('Delhi', 'Mumbai')).toBe(false);
  });

  it('refuses a subset, so half an answer is not an answer', () => {
    expect(answersMatch('Red House', 'Red')).toBe(false);
  });

  it('keeps a short word\'s s, so bus and gas are not bu and ga', () => {
    expect(normaliseAnswer('bus')).toBe('bus');
    expect(normaliseAnswer('gas')).toBe('gas');
  });

  it('keeps a double s, because chess is not a plural', () => {
    expect(normaliseAnswer('chess')).toBe('chess');
    expect(answersMatch('chess', 'chesse')).toBe(false);
  });

  it('does not treat st as filler, because it is Saint and Street as often as not', () => {
    expect(normaliseAnswer('St Mary')).toBe('mary st');
    expect(answersMatch('St Mary', 'Mary')).toBe(false);
  });
});

describe('answers with nothing identifying in them', () => {
  /**
   * An answer that normalises to nothing is a real outcome, and hashing it would store a value that any
   * other empty answer matches — so registration refuses it rather than storing it.
   */
  it('normalise to the empty string', () => {
    expect(normaliseAnswer('')).toBe('');
    expect(normaliseAnswer('   ')).toBe('');
    expect(normaliseAnswer('???')).toBe('');
    expect(normaliseAnswer('the')).toBe('');
    expect(normaliseAnswer('a')).toBe('');
  });

  it('are reported as unanswerable', () => {
    expect(isAnswerable('the')).toBe(false);
    expect(isAnswerable('Fluffy')).toBe(true);
  });

  it('never match each other, so two empty answers are not the same answer', () => {
    expect(answersMatch('the', 'a')).toBe(false);
    expect(answersMatch('', '')).toBe(false);
  });
});

describe('the canonical form itself', () => {
  /**
   * Pinned literally, because this is what gets hashed. If one of these changes, every account registered
   * before the change can no longer be recovered — so a diff touching this test is a migration question,
   * not a refactor.
   */
  it('is stable and sorted', () => {
    expect(normaliseAnswer('The Red House')).toBe('house red');
    expect(normaliseAnswer('St. Mary’s School')).toBe('mary school st');
    expect(normaliseAnswer('José García')).toBe('garcia jose');
    // `my` and `was` are both filler, so a sentence-shaped answer reduces to the three words that
    // carry the information — which is what makes "My first dog was Fluffy" and "Fluffy, first dog"
    // the same answer.
    expect(normaliseAnswer('My First Dog Was Fluffy')).toBe('dog first fluffy');
  });

  it('is idempotent, so normalising a normalised answer changes nothing', () => {
    for (const answer of ['The Red House', 'José García', 'St Mary’s', 'cats and dogs']) {
      expect(normaliseAnswer(normaliseAnswer(answer))).toBe(normaliseAnswer(answer));
    }
  });
});
