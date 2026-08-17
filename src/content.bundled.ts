import articlesEn from '../content/articles.en.json';
import curriculumEn from '../content/curriculum.en.json';
import picklists from '../content/picklists.json';
import countries from '../content/reference/countries.json';
import currencies from '../content/reference/currencies.json';
import languages from '../content/reference/languages.json';
import securityQuestionsEn from '../content/security-questions.en.json';
import tipsEn from '../content/tips.en.json';

import type { ContentSource } from './content';

/**
 * The Workers content source: the same files, carried in the Worker bundle instead of read from a
 * filesystem that does not exist there.
 *
 * ADR-0008's substance is unchanged — content is static, versioned with the deploy, ETag'd, and
 * never in the database. This restores the *mechanism* ADR-0008 originally described (imported
 * modules) for the runtime that needs it, while `src/content.ts` keeps reading from disk on Node.
 * Both feed the same zod validation and the same count assertions, so a lossy extraction fails to
 * boot on either.
 *
 * The eight files total ~196 KB of JSON, which gzips to well inside the 1 MB free-plan Worker size
 * limit and is not close to the 10 MB paid one.
 *
 * `fx-seed.json` is deliberately absent: it is read by `scripts/seed-fx.mjs`, an operator tool, not
 * by the server.
 */
const FILES: Record<string, unknown> = {
  'tips.en.json': tipsEn,
  'articles.en.json': articlesEn,
  'curriculum.en.json': curriculumEn,
  'security-questions.en.json': securityQuestionsEn,
  'picklists.json': picklists,
  'reference/countries.json': countries,
  'reference/currencies.json': currencies,
  'reference/languages.json': languages,
};

/**
 * Re-serialising the imported object rather than shipping the raw text is deliberate. `read()`
 * parses whatever this returns, so handing back a string keeps one code path — and the ETag is
 * computed downstream from `JSON.stringify` of the parsed value anyway, so a round trip through
 * text cannot change the ETag a client sees between the two runtimes.
 */
export const bundledContentSource: ContentSource = (file) => {
  const value = FILES[file];
  if (value === undefined) {
    throw new Error(`content/${file} is not in the Worker bundle; add it to src/content.bundled.ts`);
  }
  return JSON.stringify(value);
};
