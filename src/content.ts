import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * The editorial content, loaded from disk once and served from memory.
 *
 * **Not a collection** (ADR-0008, DATA_MODEL §6). Tips, articles, the curriculum and the reference
 * lists are identical for every user and change only when a deploy changes them, so putting them in
 * MongoDB would spend a connection on the four most cacheable endpoints in the system. They are
 * extracted from the design by `scripts/extract-content.mjs`, committed, and versioned with the
 * deploy.
 *
 * **Read at startup, not per request.** A file read per request would be a syscall on the hot path
 * for bytes that cannot have changed, and — worse — would make a malformed file a 500 for one user
 * rather than a refusal to boot. Everything here is loaded and validated before the port is bound.
 *
 * **Validated with zod even though we wrote the files** (Rule 1). The disk is a runtime boundary: a
 * half-finished extraction, a bad merge, or a missing `content/` directory in a container image are
 * all real, and all of them are better as a boot failure naming the file than as a screen that
 * renders nothing. The counts are asserted here too — the content *is* the product, and a deploy
 * carrying 47 tips is a broken deploy.
 */

// ── Schemas ───────────────────────────────────────────────────────────────────────────────────

const nonEmpty = z.string().min(1);

/** `{c}` is the currency token, resolved per user at render. It must survive extraction verbatim. */
const richText = nonEmpty;

const termSchema = z.object({ term: nonEmpty, detail: richText });

const tipsSchema = z.object({
  tips: z.array(z.object({ id: nonEmpty, text: richText })),
});

const articleSchema = z.object({
  id: nonEmpty,
  icon: nonEmpty,
  /**
   * Which of the client's five accent slots the article is drawn in, `1…5`.
   *
   * Assigned at extraction by mapping the design's per-article colour onto the nearest of the five
   * accents the client actually has (`[sun, mint, coral, sky, violet]`). Content rather than a client
   * constant, because it belongs to the article — a fourth article should arrive with its colour, not
   * with a client release.
   */
  accent: z.number().int().min(1).max(5),
  short: nonEmpty,
  title: nonEmpty,
  lede: richText,
  sections: z.array(
    z.object({
      heading: nonEmpty,
      paragraphs: z.array(richText).optional(),
      entries: z.array(termSchema).optional(),
      steps: z.array(richText).optional(),
      callout: richText.optional(),
    }),
  ),
  sources: z.array(z.object({ title: nonEmpty, url: z.url() })),
});

const articlesSchema = z.object({ articles: z.array(articleSchema) });

/**
 * A lesson step, as a discriminated union on `kind` — the same discriminator the client decodes.
 *
 * The answer keys ship (`answers`, `answer`). That is a conscious choice: grading is client-side for
 * responsiveness and the server recomputes every submission from these same keys (invariant 10), so
 * the cheating incentive is nil and the latency win is real.
 */
const teachStepSchema = z.object({
  kind: z.literal('teach'),
  heading: nonEmpty,
  paragraphs: z.array(richText),
  list: z.array(termSchema).optional(),
  afterList: z.array(richText).optional(),
  example: z.object({ heading: nonEmpty, body: richText }).optional(),
  tip: richText.optional(),
});

const singleChoiceStepSchema = z.object({
  kind: z.literal('singleChoice'),
  prompt: richText,
  explanation: richText,
  options: z.array(richText).min(2),
  answers: z.array(z.number().int().nonnegative()).length(1),
});

const numericStepSchema = z.object({
  kind: z.literal('numeric'),
  prompt: richText,
  explanation: richText,
  answer: z.number(),
  showsCurrencySymbol: z.boolean(),
});

const multiSelectStepSchema = z.object({
  kind: z.literal('multiSelect'),
  prompt: richText,
  explanation: richText,
  options: z.array(richText).min(2),
  answers: z.array(z.number().int().nonnegative()).min(2),
});

const stepSchema = z.discriminatedUnion('kind', [
  teachStepSchema,
  singleChoiceStepSchema,
  numericStepSchema,
  multiSelectStepSchema,
]);

const curriculumSchema = z.object({
  units: z.array(
    z.object({
      id: nonEmpty,
      number: z.number().int().positive(),
      accent: nonEmpty,
      title: nonEmpty,
      subtitle: nonEmpty,
      blurb: nonEmpty,
      lessons: z.array(
        z.object({
          id: nonEmpty,
          number: z.number().int().positive(),
          icon: nonEmpty,
          title: nonEmpty,
          blurb: nonEmpty,
          steps: z.array(stepSchema).min(1),
        }),
      ),
    }),
  ),
});

const picklistOptionSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
  opensFreeText: z.boolean().optional(),
});

const picklistsSchema = z.object({
  transport: z.array(picklistOptionSchema),
  other: z.array(picklistOptionSchema),
});

const countriesSchema = z.object({
  countries: z.array(
    z.object({ code: z.string().length(2), dialCode: z.string().regex(/^\+\d+$/), name: nonEmpty }),
  ),
});

const currenciesSchema = z.object({
  currencies: z.array(
    z.object({
      code: z.string().length(3),
      name: nonEmpty,
      symbol: nonEmpty,
      // 0–3, never guessed: `Money.minor` is a count of this currency's smallest unit, so an
      // exponent that is wrong by one is a salary that is wrong by a factor of ten (ADR-0001).
      exponent: z.number().int().min(0).max(3),
    }),
  ),
});

const languagesSchema = z.object({
  languages: z.array(
    z.object({ code: nonEmpty, name: nonEmpty, nativeName: nonEmpty, shipped: z.boolean() }),
  ),
});

const securityQuestionsSchema = z.object({
  questions: z.array(z.object({ id: nonEmpty, text: nonEmpty })),
});

/**
 * The screen-builder UI strings, per language.
 *
 * **Plumbing, not counts.** Unlike tips/curriculum/etc., these have no fixed cardinality to assert — they
 * are the fixed set of labels the screen builders (`home`, `expenses`, `account`) emit, sourced from a
 * per-language file so a translation pass can drop real copy in later. Strict so a stray key or a missing
 * one fails to boot rather than rendering a blank label. Templates carry `{token}` placeholders
 * (`{xp}`, `{lesson}`, `{n}`) that the builder interpolates.
 */
const uiSchema = z
  .object({
    home: z
      .object({
        greeting: z
          .object({ morning: nonEmpty, afternoon: nonEmpty, evening: nonEmpty })
          .strict(),
        ofPay: nonEmpty,
        ofGoal: nonEmpty,
        categories: z
          .object({
            rent: nonEmpty,
            groceries: nonEmpty,
            transport: nonEmpty,
            utilities: nonEmpty,
            entertainment: nonEmpty,
            other: nonEmpty,
          })
          .strict(),
        learning: z
          .object({ noXp: nonEmpty, xpComplete: nonEmpty, noXpStart: nonEmpty, xpNext: nonEmpty })
          .strict(),
      })
      .strict(),
    expenses: z
      .object({
        categories: z
          .object({
            groceries: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
            transport: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
            entertainment: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
            other: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
            income: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
            utilities: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
            rent: z.object({ name: nonEmpty, hint: nonEmpty }).strict(),
          })
          .strict(),
        relativeDay: z
          .object({ today: nonEmpty, yesterday: nonEmpty, daysAgo: nonEmpty })
          .strict(),
        entryCount: z.object({ one: nonEmpty, other: nonEmpty }).strict(),
      })
      .strict(),
    account: z
      .object({
        rows: z
          .object({
            personalInformation: z.object({ name: nonEmpty, sub: nonEmpty }).strict(),
            language: z.object({ name: nonEmpty, sub: nonEmpty }).strict(),
            currency: z.object({ name: nonEmpty, sub: nonEmpty }).strict(),
            password: z.object({ name: nonEmpty }).strict(),
          })
          .strict(),
        passwordChanged: z
          .object({
            set: nonEmpty,
            justNow: nonEmpty,
            yesterday: nonEmpty,
            daysAgo: nonEmpty,
            monthsAgoOne: nonEmpty,
            monthsAgoOther: nonEmpty,
            yearsAgoOne: nonEmpty,
            yearsAgoOther: nonEmpty,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

// ── Types, inferred from the schemas (Rule 1) ─────────────────────────────────────────────────

export type Tips = z.infer<typeof tipsSchema>;
export type Article = z.infer<typeof articleSchema>;
export type Articles = z.infer<typeof articlesSchema>;
export type Curriculum = z.infer<typeof curriculumSchema>;
export type LessonStep = z.infer<typeof stepSchema>;
export type Lesson = Curriculum['units'][number]['lessons'][number];
export type Picklists = z.infer<typeof picklistsSchema>;
export type Countries = z.infer<typeof countriesSchema>;
export type Currencies = z.infer<typeof currenciesSchema>;
export type Currency = Currencies['currencies'][number];
export type Languages = z.infer<typeof languagesSchema>;
export type SecurityQuestions = z.infer<typeof securityQuestionsSchema>;
export type Ui = z.infer<typeof uiSchema>;

// ── Language ──────────────────────────────────────────────────────────────────────────────────

/**
 * The languages content exists in. Each entry MUST have the four `content/<name>.<lang>.json` files on
 * disk (`tips`, `articles`, `curriculum`, `security-questions`) with matching ids and counts — `loadLanguage`
 * asserts that at boot — and it is the list `resolveLanguage` narrows to.
 *
 * `ar` and `hi` are wired here so the whole translation pipeline is live end to end; their content files
 * currently carry English placeholder copy awaiting a translation pass, so a reader who picks Arabic or
 * Hindi gets the localised *plumbing* (the right file served, dates formatted in-locale) with English words
 * until the copy lands. That is a deliberate, temporary state — the same one the iOS `AppLanguage` doc notes.
 */
export const SHIPPED_LANGUAGES = ['en', 'ar', 'hi', 'fil', 'ne', 'ur'] as const;
export type Language = (typeof SHIPPED_LANGUAGES)[number];

/**
 * The languages the Account screen **offers as a preference** — which is deliberately not
 * `SHIPPED_LANGUAGES`.
 *
 * The two lists answer different questions. `SHIPPED_LANGUAGES` is "which content files exist on disk";
 * this is "which languages a reader may choose to be". They are allowed to differ because the second is a
 * stored fact about a person and the first is a build artefact: a reader can say they are a Hindi speaker
 * before the Hindi copy is written, and `resolveLanguage` narrows content to what actually exists, so they
 * get English words rather than an error.
 *
 * Keep the widening one-way. A language may appear here before it has files; a language with files must
 * never be missing from here, or a reader could not choose the copy that already exists.
 */
export const PREFERENCE_LANGUAGES = ['en', 'ar', 'hi', 'fil', 'ne', 'ur'] as const;
export type PreferenceLanguage = (typeof PREFERENCE_LANGUAGES)[number];

/**
 * The language to serve, from an `Accept-Language` header.
 *
 * Falls back to English rather than failing: a reader whose device is set to French should get
 * English content, not an error. Every content response carries `Vary: Accept-Language` so that a
 * cache keyed on the header is correct the day Arabic lands — adding a language must not serve
 * English bytes from an edge cache to an Arabic reader.
 */
export function resolveLanguage(header: string | undefined): Language {
  if (header === undefined) return 'en';

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(';');
      const quality = parameters
        .map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter))
        .find((match) => match !== null);
      return { tag: (tag ?? '').toLowerCase(), quality: quality ? Number(quality[1]) : 1 };
    })
    .filter(({ tag, quality }) => tag !== '' && quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    // `en-GB` and `en` both mean the `en` files; `*` means "anything", which is English.
    const base = tag.split('-')[0];
    if (base === '*') return 'en';
    const match = SHIPPED_LANGUAGES.find((language) => language === base);
    if (match !== undefined) return match;
  }
  return 'en';
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────

/**
 * One loaded content resource: the value, and the bytes and ETag the response is built from.
 *
 * **The bytes are kept, not re-serialised per request.** Two reasons, and the second is the one that
 * matters: `JSON.stringify` per request on a 100 KB curriculum is wasted CPU, and an ETag must
 * describe the exact bytes sent — deriving it from a value that is re-serialised each time risks the
 * header and the body disagreeing.
 */
export interface ContentResource<Value> {
  readonly value: Value;
  readonly body: string;
  readonly etag: string;
}

/**
 * A strong ETag over the served bytes.
 *
 * Strong rather than weak (`W/`): these bytes are byte-for-byte identical between deploys unless the
 * content changed, so the stronger promise is the true one, and `If-None-Match` comparison is exact.
 * Truncated to 32 hex characters — 128 bits is far past collision concern for a few dozen documents
 * and keeps the header readable in a log.
 */
function resourceFrom<Value>(value: Value): ContentResource<Value> {
  const body = JSON.stringify(value);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  return { value, body, etag };
}

/**
 * Where the raw bytes of a content file come from.
 *
 * ADR-0008, as amended by ADR-0016, says content is static, versioned with the deploy, ETag'd and
 * never in the database. That reasoning is about *where content lives in the architecture*, and it
 * is untouched here. What varies is only the mechanism of the read: Node reads the files from disk
 * beside the entrypoint, and a Cloudflare Worker has no filesystem, so its bundle carries them as
 * imported modules. Both hand the same JSON text to the same validation below.
 *
 * @param file a path relative to `content/`, e.g. `tips.en.json` or `reference/countries.json`.
 * @throws if the file cannot be produced; the caller wraps it with the file name attached.
 */
export type ContentSource = (file: string) => string;

/**
 * The Node source: the files on disk beside the entrypoint, as ADR-0008-as-amended describes.
 *
 * The directory is resolved inside the function rather than at module scope, because
 * `import.meta.dirname` is undefined under workerd and computing it on import would throw before
 * a Worker ever got the chance to install its own source.
 */
function diskSource(file: string): string {
  return readFileSync(path.join(import.meta.dirname, '..', 'content', file), 'utf8');
}

let source: ContentSource = diskSource;

/**
 * Install a different way of producing content bytes, before `loadContent` is called.
 *
 * The Worker entrypoint uses this to serve the content its bundle already contains. Calling it
 * after content is loaded has no effect, which is why it throws rather than failing quietly — a
 * source installed too late would silently be the wrong one.
 */
export function setContentSource(next: ContentSource): void {
  if (loaded) {
    throw new ContentError(
      'setContentSource was called after loadContent; install the source from the entrypoint ' +
        'before any content is read.',
    );
  }
  source = next;
}

/**
 * Read and validate one content file.
 *
 * @throws {ContentError} naming the file and the problem. Called only during startup, so throwing
 * is the fail-fast the module docstring promises.
 */
function read<Schema extends z.ZodType>(file: string, schema: Schema): z.infer<Schema> {
  let raw: string;
  try {
    raw = source(file);
  } catch (err) {
    throw new ContentError(
      `content/${file} could not be read (${err instanceof Error ? err.message : String(err)}). ` +
        'Run `npm run content:extract`, and check that content/ is present in the deployed image.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ContentError(
      `content/${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ContentError(`content/${file} does not match its schema:\n${problems}`);
  }
  return result.data;
}

/** Raised when the content on disk cannot produce a usable set of documents. */
export class ContentError extends Error {
  override readonly name = 'ContentError';
}

/**
 * Every count from `BACKEND_PLAN.md` §4 slice 1, asserted at boot as well as in the test suite.
 *
 * **Exactly, not as a range.** The prototype's own "115 steps" comment is stale; the verified count
 * is 124, decomposed into 58 teach and 66 question steps so that a lesson losing a question and
 * gaining a teach page cannot pass. The extraction script asserts the same numbers, which is
 * deliberate duplication: the script protects the developer running it, and this protects the
 * deploy that ships whatever is committed.
 */
function assertCounts(content: LoadedContent): void {
  const lessons = content.curriculum.value.units.flatMap((unit) => unit.lessons);
  const steps = lessons.flatMap((lesson) => lesson.steps);
  const kind = (name: LessonStep['kind']): number => steps.filter((s) => s.kind === name).length;

  const expected: [string, number, number][] = [
    ['tips', content.tips.value.tips.length, 49],
    ['articles', content.articles.value.articles.length, 3],
    ['units', content.curriculum.value.units.length, 5],
    ['lessons', lessons.length, 15],
    ['steps', steps.length, 124],
    ['teach steps', kind('teach'), 58],
    ['question steps', steps.length - kind('teach'), 66],
    ['single-choice steps', kind('singleChoice'), 50],
    ['numeric steps', kind('numeric'), 14],
    ['multi-select steps', kind('multiSelect'), 2],
    ['countries', content.countries.value.countries.length, 251],
    ['currencies', content.currencies.value.currencies.length, 160],
    ['languages', content.languages.value.languages.length, 87],
    ['transport modes', content.picklists.value.transport.length, 22],
    ['other types', content.picklists.value.other.length, 20],
    ['security questions', content.securityQuestions.value.questions.length, 14],
  ];

  const wrong = expected
    .filter(([, actual, target]) => actual !== target)
    .map(([label, actual, target]) => `  ${label}: ${String(actual)}, expected ${String(target)}`);

  if (wrong.length > 0) {
    throw new ContentError(
      `the content on disk has the wrong counts — the extraction is lossy or the files are stale:\n${wrong.join('\n')}\n\n` +
        'Run `npm run content:extract` against HisaabwiseDesigns/HisaabWise 6.html.',
    );
  }
}

/** Ids must be unique, because every one of them is used as a key somewhere. */
function assertUniqueIds(content: LoadedContent): void {
  const duplicates: string[] = [];
  const check = (label: string, ids: string[]): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(`${label}: ${id}`);
      seen.add(id);
    }
  };

  check('tip', content.tips.value.tips.map((tip) => tip.id));
  check('article', content.articles.value.articles.map((article) => article.id));
  check('unit', content.curriculum.value.units.map((unit) => unit.id));
  check('lesson', content.curriculum.value.units.flatMap((u) => u.lessons.map((l) => l.id)));
  check('currency', content.currencies.value.currencies.map((currency) => currency.code));
  check('country', content.countries.value.countries.map((country) => country.code));
  check('security question', content.securityQuestions.value.questions.map((q) => q.id));
  check('transport option', content.picklists.value.transport.map((option) => option.id));
  check('other option', content.picklists.value.other.map((option) => option.id));

  if (duplicates.length > 0) {
    throw new ContentError(`duplicate content ids:\n  ${duplicates.join('\n  ')}`);
  }
}

/** One article without its body — what a teaser list carries. */
export type ArticleTeaser = Omit<Article, 'sections' | 'sources'>;

const teaserOf = (article: Article): ArticleTeaser => ({
  id: article.id,
  icon: article.icon,
  accent: article.accent,
  short: article.short,
  title: article.title,
  lede: article.lede,
});

/** Everything one language's content amounts to. */
export interface LoadedContent {
  readonly language: Language;
  readonly tips: ContentResource<Tips>;
  /** The teaser projection — what `GET /v1/content/articles` answers with. */
  readonly articleTeasers: ContentResource<{ articles: ArticleTeaser[] }>;
  /** The full documents, by id, each with its own ETag — an article body is fetched on its own. */
  readonly articles: ContentResource<Articles>;
  readonly articleById: ReadonlyMap<string, ContentResource<Article>>;
  readonly curriculum: ContentResource<Curriculum>;
  readonly picklists: ContentResource<Picklists>;
  readonly countries: ContentResource<Countries>;
  readonly currencies: ContentResource<Currencies>;
  readonly languages: ContentResource<Languages>;
  readonly securityQuestions: ContentResource<SecurityQuestions>;
  /** The screen-builder UI strings — no fixed counts, so not in `assertCounts`. */
  readonly ui: ContentResource<Ui>;
  /** Lessons by id, in curriculum order — the lookup Learn's grading and unlocking both need. */
  readonly lessonById: ReadonlyMap<string, Lesson>;
  /** Currency exponents and symbols by code — the money domain's only source for them. */
  readonly currencyByCode: ReadonlyMap<string, Currency>;
}

function loadLanguage(language: Language): LoadedContent {
  // Translated content is per language; the reference lists and pick lists are not — a dial code
  // and an ISO currency code are the same in every language, and the *names* in them are the one
  // place Arabic will need a second file (BACKEND_PLAN §8).
  const tips = read(`tips.${language}.json`, tipsSchema);
  const articles = read(`articles.${language}.json`, articlesSchema);
  const curriculum = read(`curriculum.${language}.json`, curriculumSchema);
  const securityQuestions = read(`security-questions.${language}.json`, securityQuestionsSchema);
  const ui = read(`ui.${language}.json`, uiSchema);
  const picklists = read('picklists.json', picklistsSchema);
  const countries = read('reference/countries.json', countriesSchema);
  const currencies = read('reference/currencies.json', currenciesSchema);
  const languages = read('reference/languages.json', languagesSchema);

  const content: LoadedContent = {
    language,
    tips: resourceFrom(tips),
    articles: resourceFrom(articles),
    articleTeasers: resourceFrom({ articles: articles.articles.map(teaserOf) }),
    articleById: new Map(articles.articles.map((article) => [article.id, resourceFrom(article)])),
    curriculum: resourceFrom(curriculum),
    picklists: resourceFrom(picklists),
    countries: resourceFrom(countries),
    currencies: resourceFrom(currencies),
    languages: resourceFrom(languages),
    securityQuestions: resourceFrom(securityQuestions),
    ui: resourceFrom(ui),
    lessonById: new Map(
      curriculum.units.flatMap((unit) => unit.lessons.map((lesson) => [lesson.id, lesson] as const)),
    ),
    currencyByCode: new Map(currencies.currencies.map((currency) => [currency.code, currency])),
  };

  assertCounts(content);
  assertUniqueIds(content);
  return content;
}

let loaded: Map<Language, LoadedContent> | undefined;

/**
 * Load every shipped language's content, validating as it goes.
 *
 * Called once from the entrypoint, before the port is bound. Idempotent, so a test may call it
 * without paying for a second parse.
 *
 * @throws {ContentError} if any file is missing, malformed, or has the wrong counts.
 */
export function loadContent(): Map<Language, LoadedContent> {
  loaded ??= new Map(SHIPPED_LANGUAGES.map((language) => [language, loadLanguage(language)]));
  return loaded;
}

/**
 * The content for one language.
 *
 * @throws if called before `loadContent`. Like `getMongoClient`, that is a programming error rather
 * than an operational one — it means something reached for content outside the request lifecycle.
 */
export function getContent(language: Language = 'en'): LoadedContent {
  if (!loaded) {
    throw new Error('Content has not been loaded. Call loadContent() from the entrypoint.');
  }
  const content = loaded.get(language);
  if (!content) throw new Error(`No content is loaded for language "${language}".`);
  return content;
}
