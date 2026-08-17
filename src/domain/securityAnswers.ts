/**
 * The canonical form of a security answer (invariant 5, ADR-0004).
 *
 * **The problem this solves.** Security answers are the *entire* account-recovery mechanism — there is
 * no email reset and no SMS (BACKEND_PLAN §4.2.1) — so they have to tolerate how a person actually
 * types six months later, while the stored form has to be a hash. Those two requirements fight: fuzzy
 * matching wants the original string, and invariant 5 forbids keeping it.
 *
 * The resolution is to **normalise, then hash, then compare exactly**. Every tolerance the system
 * offers is baked into the normaliser and applied identically at registration and at verification.
 * Levenshtein distance was deliberately dropped: it cannot be computed against a hash, so `Jaipur`
 * against a stored `Jodhpur` fails — as intended.
 *
 * The pipeline, from ADR-0004:
 *
 * ```
 * NFD accent-strip → lowercase → strip apostrophes → punctuation to space → split
 *   → drop words of length ≤ 1 → drop the filler list → singularise a trailing "s"
 *   → sort → join
 * ```
 *
 * **Sorting is what makes it order-insensitive**, matching the prototype's intent: "Saint Mary's" and
 * "Mary Saint" normalise alike. That is a deliberate widening — it accepts a reordering the user did
 * not make — and it is the right trade for a mechanism whose failure mode is a permanently locked
 * account.
 *
 * Pure, and tested without a database (ADR-0014): this is one of the highest-value test targets in
 * the codebase, because a change here silently locks out everyone who registered before it.
 */

/**
 * Words carrying no identifying information, dropped so that "the red house" and "red house" match.
 *
 * **Kept deliberately short.** Every word removed widens the set of answers that collide, and a
 * collision here is somebody else's account. Articles, conjunctions, the commonest prepositions and
 * possessives — nothing that could be part of a name, a place, or a title. `st` is *not* on the list:
 * it is "Saint" and "Street" as often as it is filler.
 */
const FILLER = new Set([
  'the', 'and', 'an', 'of', 'my', 'our', 'his', 'her', 'their', 'its',
  'in', 'at', 'on', 'to', 'for', 'from', 'with', 'by',
  'is', 'was', 'were', 'be', 'am', 'are',
  'it', 'that', 'this', 'these', 'those',
]);

/**
 * Drop a plural `s`, so "cats" and "cat" match.
 *
 * Only for words longer than three characters, and never after another `s`. Both bounds exist to stop
 * the rule eating real words: `bus` and `gas` keep their `s` because they are short, and `chess` keeps
 * both because `chess` is not a plural. A crude rule applied consistently beats a correct one applied
 * to only the words somebody thought of — the requirement is that registration and verification agree,
 * not that the linguistics are right.
 */
function singularise(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The normalised form of one answer, or the empty string if nothing identifying was left.
 *
 * An empty result is a real outcome — an answer of "the" or "??" reduces to nothing — and callers must
 * treat it as a refusal rather than hashing it. `assertAnswerable` is how registration does that.
 */
export function normaliseAnswer(answer: string): string {
  return (
    answer
      // Accents are stripped rather than preserved, so `José` and `Jose` match. NFD splits a letter
      // from its diacritic, and the range covers the combining marks that produces.
      .normalize('NFD')
      .replaceAll(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Apostrophes vanish rather than becoming spaces, so `Mary's` is one word `marys` — which
      // `singularise` then reduces to `mary`. Both the typographic and the typewriter form, because a
      // phone keyboard produces the former and a desktop the latter.
      .replaceAll(/['’ʼ]/g, '')
      .replaceAll(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((word) => word.length > 1)
      .filter((word) => !FILLER.has(word))
      .map(singularise)
      .sort()
      .join(' ')
  );
}

/** Whether an answer normalises to anything worth storing. */
export const isAnswerable = (answer: string): boolean => normaliseAnswer(answer).length > 0;

/**
 * Whether two answers are the same answer.
 *
 * Not used on the hot path — verification compares hashes, because the stored form is a hash — but it
 * is what the test suite asserts tolerance with, and it documents the comparison the hashes stand in
 * for.
 */
export const answersMatch = (a: string, b: string): boolean =>
  isAnswerable(a) && normaliseAnswer(a) === normaliseAnswer(b);
