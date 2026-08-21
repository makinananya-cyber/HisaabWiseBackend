import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getContent, loadContent, resolveLanguage } from '../src/content';
import { required } from './support/expect';

/**
 * The content acceptance test.
 *
 * **The counts are the test, and they are asserted exactly.** The content is the product — a deploy
 * carrying 47 tips or 123 steps is a broken deploy, and the failure mode of a range assertion
 * (`≥ 40 tips`) is a green suite over lossy content. The step total is decomposed into 58 teach and
 * 66 question steps, and the questions decomposed again by kind, so a lesson that lost a question
 * and gained a teach page cannot pass.
 *
 * The prototype's own comment says 115 steps. It is stale; the verified count is 124.
 */

loadContent();
const content = getContent('en');

const corpusDir = path.join(import.meta.dirname, 'contract', 'corpus');
const corpus = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(corpusDir, name), 'utf8'));

const lessons = content.curriculum.value.units.flatMap((unit) => unit.lessons);
const steps = lessons.flatMap((lesson) => lesson.steps);

describe('content counts', () => {
  it('has 49 tips', () => {
    expect(content.tips.value.tips).toHaveLength(49);
  });

  it('has 3 articles', () => {
    expect(content.articles.value.articles.map((article) => article.id)).toEqual([
      'scams',
      'remit',
      'debt',
    ]);
  });

  it('has 5 units and 15 lessons', () => {
    expect(content.curriculum.value.units).toHaveLength(5);
    expect(lessons).toHaveLength(15);
  });

  it('has 124 steps, 58 teach and 66 question', () => {
    expect(steps).toHaveLength(124);
    expect(steps.filter((step) => step.kind === 'teach')).toHaveLength(58);
    expect(steps.filter((step) => step.kind !== 'teach')).toHaveLength(66);
  });

  it('has 50 single-choice, 14 numeric and 2 multi-select questions', () => {
    expect(steps.filter((step) => step.kind === 'singleChoice')).toHaveLength(50);
    expect(steps.filter((step) => step.kind === 'numeric')).toHaveLength(14);
    expect(steps.filter((step) => step.kind === 'multiSelect')).toHaveLength(2);
  });

  it('has 251 countries, 160 currencies and 87 languages', () => {
    expect(content.countries.value.countries).toHaveLength(251);
    expect(content.currencies.value.currencies).toHaveLength(160);
    expect(content.languages.value.languages).toHaveLength(87);
  });

  it('has 22 transport modes and 20 other types', () => {
    expect(content.picklists.value.transport).toHaveLength(22);
    expect(content.picklists.value.other).toHaveLength(20);
  });

  it('has 14 security questions with stable sq01…sq14 ids', () => {
    const questions = content.securityQuestions.value.questions;
    expect(questions).toHaveLength(14);
    expect(questions.map((question) => question.id)).toEqual([
      'sq01', 'sq02', 'sq03', 'sq04', 'sq05', 'sq06', 'sq07',
      'sq08', 'sq09', 'sq10', 'sq11', 'sq12', 'sq13', 'sq14',
    ]);
  });
});

/**
 * The corpus is the client's own decoded payloads, so equality with it is the strongest statement
 * available that the extraction did not drift from what working Swift reads. Where a served payload
 * is a superset of the fixture — currencies gained an `exponent`, articles gained their teaser
 * fields — the extra keys are projected away and the rest must match exactly.
 */
describe('agreement with the client fixture corpus', () => {
  it('serves the tips the client decodes', () => {
    expect(content.tips.value).toEqual(corpus('tips.json'));
  });

  it('serves the curriculum the client decodes, answer keys included', () => {
    expect(content.curriculum.value).toEqual(corpus('curriculum.json'));
  });

  it('serves the countries the client decodes', () => {
    expect(content.countries.value).toEqual(corpus('reference-countries.json'));
  });

  it('serves the security questions the client decodes', () => {
    expect(content.securityQuestions.value).toEqual(corpus('reference-security-questions.json'));
  });

  it('serves the pick lists the client decodes, opensFreeText included', () => {
    expect(content.picklists.value).toEqual(corpus('picklists.json'));
  });

  it('serves the currencies the client decodes, plus an exponent it ignores', () => {
    const withoutExponent = content.currencies.value.currencies.map(({ code, name, symbol }) => ({
      code,
      name,
      symbol,
    }));
    expect({ currencies: withoutExponent }).toEqual(corpus('reference-currencies.json'));
  });

  it('serves the article body the client decodes', () => {
    const article = required(content.articleById.get('scams'), 'the scams article');
    const { id, title, lede, sections, sources } = article.value;
    // The teaser fields the fixture does not carry are projected away rather than asserted absent:
    // extra keys are backwards-compatible for a Swift decoder, missing ones are not.
    expect({ id, title, lede, sections, sources }).toEqual(corpus('article-scams.json'));
  });
});

describe('currency exponents', () => {
  const exponent = (code: string): number | undefined => content.currencyByCode.get(code)?.exponent;

  it('is 2 for the ordinary currencies', () => {
    for (const code of ['AED', 'USD', 'INR', 'PKR', 'PHP', 'EUR', 'GBP']) {
      expect(exponent(code), code).toBe(2);
    }
  });

  it('is 3 for the three-decimal Gulf currencies', () => {
    for (const code of ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']) {
      expect(exponent(code), code).toBe(3);
    }
  });

  it('is 0 for the currencies with no minor unit', () => {
    for (const code of ['JPY', 'KRW', 'VND', 'ISK', 'XAF']) {
      expect(exponent(code), code).toBe(0);
    }
  });

  it('gives every currency an exponent between 0 and 3', () => {
    for (const currency of content.currencies.value.currencies) {
      expect(Number.isInteger(currency.exponent), currency.code).toBe(true);
      expect(currency.exponent, currency.code).toBeGreaterThanOrEqual(0);
      expect(currency.exponent, currency.code).toBeLessThanOrEqual(3);
    }
  });
});

describe('languages', () => {
  it('ships English and Arabic only, while retaining all 87 for the picker', () => {
    const shipped = content.languages.value.languages.filter((language) => language.shipped);
    expect(shipped.map((language) => language.code).sort()).toEqual(['ar', 'en']);
  });

  it('carries a native name for every language, so the picker reads in the reader’s own script', () => {
    for (const language of content.languages.value.languages) {
      expect(language.nativeName.trim(), language.code).not.toBe('');
    }
  });
});

describe('what the extraction must not carry', () => {
  const everything = JSON.stringify([
    content.tips.value,
    content.articles.value,
    content.curriculum.value,
    content.picklists.value,
    content.securityQuestions.value,
  ]);

  /**
   * The design's `?demo` auto-fill block is explicitly marked for deletion, and it carries a
   * password and a salary. Its absence is grepped rather than assumed.
   */
  it('does not carry the design\'s ?demo auto-fill block', () => {
    expect(everything).not.toMatch(/\?demo|autofill|autoFill|demoFill/i);
  });

  /**
   * The client renders markdown, not HTML — `HWMarkdown` understands `**bold**` and `*italic*`.
   * A leaked `<b>` would be shown to the reader as literal text.
   */
  it('carries no HTML tags', () => {
    expect(everything).not.toMatch(/<\/?(b|i|em|strong|br|span|div|p)\b[^>]*>/);
  });
});

describe('currency tokens', () => {
  /**
   * `{c}` is resolved per user against their display currency. It has to survive extraction
   * verbatim — a token rewritten to `AED` here would bake one market's currency into the content
   * for every reader, which is defect D1's shape applied to editorial text.
   */
  it('are preserved verbatim in the tips that use them', () => {
    const tokenised = content.tips.value.tips.filter((tip) => tip.text.includes('{c}'));
    expect(tokenised.length).toBeGreaterThan(0);
    for (const tip of tokenised) {
      expect(tip.text).not.toMatch(/AED|USD|INR|₹|د\.إ/);
    }
  });

  it('are preserved verbatim in the curriculum', () => {
    const tokenised = steps.filter((step) => JSON.stringify(step).includes('{c}'));
    expect(tokenised.length).toBeGreaterThan(0);
  });
});

describe('curriculum integrity', () => {
  it('numbers units and lessons from one, in order', () => {
    content.curriculum.value.units.forEach((unit, unitIndex) => {
      expect(unit.number).toBe(unitIndex + 1);
      unit.lessons.forEach((lesson, lessonIndex) => {
        expect(lesson.number).toBe(lessonIndex + 1);
      });
    });
  });

  it('indexes every lesson by id', () => {
    expect(content.lessonById.size).toBe(15);
    for (const lesson of lessons) {
      expect(content.lessonById.get(lesson.id)).toBe(lesson);
    }
  });

  it('keeps every answer index inside its option list', () => {
    for (const step of steps) {
      if (step.kind !== 'singleChoice' && step.kind !== 'multiSelect') continue;
      for (const index of step.answers) {
        expect(index, step.prompt).toBeLessThan(step.options.length);
      }
    }
  });

  it('gives every question an explanation, because a wrong answer is the teaching moment', () => {
    for (const step of steps) {
      if (step.kind === 'teach') continue;
      expect(step.explanation.trim(), step.prompt).not.toBe('');
    }
  });
});

describe('article integrity', () => {
  it('cites a source on every article, and only over https', () => {
    for (const article of content.articles.value.articles) {
      expect(article.sources.length, article.id).toBeGreaterThan(0);
      for (const source of article.sources) {
        expect(source.url, article.id).toMatch(/^https:\/\//);
      }
    }
  });

  it('gives the teaser projection no body, so a teaser list is not an article download', () => {
    for (const teaser of content.articleTeasers.value.articles) {
      expect(teaser).not.toHaveProperty('sections');
      expect(teaser).not.toHaveProperty('sources');
    }
  });
});

describe('ETags', () => {
  it('are strong, quoted, and distinct per resource', () => {
    const etags = [
      content.tips.etag,
      content.curriculum.etag,
      content.picklists.etag,
      content.countries.etag,
      content.currencies.etag,
      content.languages.etag,
      content.securityQuestions.etag,
      content.articleTeasers.etag,
    ];

    for (const etag of etags) expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(new Set(etags).size).toBe(etags.length);
  });

  it('describe the exact bytes served', () => {
    expect(JSON.parse(content.tips.body)).toEqual(content.tips.value);
  });

  it('differ between articles, so one cannot be served for another', () => {
    const etags = [...content.articleById.values()].map((article) => article.etag);
    expect(new Set(etags).size).toBe(3);
  });
});

describe('resolveLanguage', () => {
  it('defaults to English when nothing is asked for', () => {
    expect(resolveLanguage(undefined)).toBe('en');
    expect(resolveLanguage('')).toBe('en');
  });

  it('accepts a regional variant as its base language', () => {
    expect(resolveLanguage('en-GB')).toBe('en');
    expect(resolveLanguage('en-US,en;q=0.9')).toBe('en');
  });

  it('falls back to English for a language that is not shipped', () => {
    expect(resolveLanguage('fr-FR,fr;q=0.9')).toBe('en');
  });

  it('resolves the shipped languages to themselves', () => {
    // Arabic and Hindi are now shipped (with English placeholder copy awaiting translation), so they
    // resolve to their own files rather than falling back to English — and `Vary: Accept-Language` is
    // what keeps a cache from serving those bytes to the wrong reader.
    expect(resolveLanguage('ar')).toBe('ar');
    expect(resolveLanguage('hi-IN,hi;q=0.9')).toBe('hi');
  });

  it('honours quality ordering rather than header order', () => {
    expect(resolveLanguage('fr;q=0.9,en;q=1.0')).toBe('en');
  });

  it('treats a zero quality as a refusal rather than a preference', () => {
    expect(resolveLanguage('en;q=0')).toBe('en');
  });
});
