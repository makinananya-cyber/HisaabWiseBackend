#!/usr/bin/env node
/**
 * Extracts the editorial content from the design prototype into `content/`.
 *
 * **Why a script and not a one-off paste.** The content *is* the product — 49 tips, 3 articles, a
 * 124-step curriculum — and `HisaabwiseDesigns/HisaabWise 6.html` is its source of truth (Rule 5).
 * A hand-copied extraction cannot be re-run when an editor changes a lesson, and cannot be shown to
 * be complete. This can: it is deterministic, it asserts every count from
 * `BACKEND_PLAN.md` §4 slice 1, and `test/content.test.ts` re-asserts them against the committed
 * output so a bad re-run cannot land quietly.
 *
 * **How it reads the design.** The prototype is a shell page holding one `SCREENS` object whose
 * values are complete HTML documents, one per screen, as string literals. So the data lives *inside
 * strings inside a script* — regex over the outer file finds the text but cannot bound the literal,
 * and the outer script's own AST does not contain it. The route that works is two passes: parse the
 * shell, evaluate `SCREENS`, then parse each screen's own `<script>` and take the declaration by
 * name from its AST. Bracket-matching was tried first and fails on the prototype's regex literals
 * and template strings.
 *
 * **What it does not extract.** The `?demo` auto-fill block, which the design marks for deletion.
 * Its absence is asserted by `test/content.test.ts`.
 *
 *   node scripts/extract-content.mjs [--check]
 *
 * `--check` writes nothing and exits non-zero if the committed output differs — the drift gate.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'acorn';

const repoRoot = path.join(import.meta.dirname, '..');
const designPath = path.join(repoRoot, '..', 'HisaabwiseDesigns', 'HisaabWise 6.html');
const contentDir = path.join(repoRoot, 'content');

const checkOnly = process.argv.includes('--check');

// ── Reading the design ────────────────────────────────────────────────────────────────────────

const scriptBlocks = (source) =>
  [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

/**
 * Every `const NAME = <expression>` in one script, as source text, keyed by name.
 *
 * The whole AST is walked rather than just top-level statements: the prototype declares some of
 * these inside the IIFE that renders its screen.
 */
function declarationsIn(source) {
  const found = new Map();
  let tree;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch {
    // A screen's inline script that does not parse standalone is not where the data is.
    return found;
  }

  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const element of node) visit(element);
      return;
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      if (!found.has(node.id.name)) {
        found.set(node.id.name, source.slice(node.init.start, node.init.end));
      }
    }
    for (const value of Object.values(node)) visit(value);
  };

  visit(tree);
  return found;
}

/**
 * The named declarations from the design, each from the screen that owns it.
 *
 * `new Function` rather than a JSON parse because these are JS literals — trailing commas, single
 * quotes, unquoted keys. They are data literals in a file the project owns, evaluated by a
 * developer running a build script, so this is not a runtime boundary.
 */
function readDesign() {
  const html = readFileSync(designPath, 'utf8');
  const shell = declarationsIn(scriptBlocks(html)[0]);
  const screensSource = shell.get('SCREENS');
  if (screensSource === undefined) {
    throw new Error('the design shell no longer declares SCREENS — the extraction needs revisiting');
  }
  const screens = new Function(`return (${screensSource});`)();

  const wanted = [
    'TIPS',
    'ARTICLES',
    'CURRICULUM',
    'COUNTRIES',
    'CURRENCIES',
    'QUESTIONS',
    'TRANSPORT',
    'OTHER',
    'LANGUAGES',
  ];
  const data = {};
  for (const screen of Object.values(screens)) {
    for (const block of scriptBlocks(screen)) {
      const declared = declarationsIn(block);
      for (const name of wanted) {
        if (data[name] !== undefined) continue;
        const source = declared.get(name);
        if (source !== undefined) data[name] = new Function(`return (${source});`)();
      }
    }
  }

  const missing = wanted.filter((name) => data[name] === undefined);
  if (missing.length > 0) throw new Error(`the design no longer declares: ${missing.join(', ')}`);
  return data;
}

// ── Markup ────────────────────────────────────────────────────────────────────────────────────

/**
 * The design's inline HTML, as the markdown the client renders.
 *
 * `HWMarkdown` on iOS understands `**bold**` and `*italic*`; the design writes `<b>` and `<i>`.
 * `<br>` becomes a newline because the client's `example.body` is one string with line breaks, not
 * a paragraph array. `{c}` currency tokens are left **verbatim** — they are resolved per user
 * against their display currency, and rewriting one here would bake a currency into the content.
 */
function markdown(html) {
  const converted = html
    .replaceAll(/<br\s*\/?>/g, '\n')
    .replaceAll(/<\/?b>/g, '**')
    .replaceAll(/<\/?strong>/g, '**')
    .replaceAll(/<\/?i>/g, '*')
    .replaceAll(/<\/?em>/g, '*');

  if (/<[a-z][^>]*>/i.test(converted)) {
    throw new Error(`unhandled markup in content: ${converted.slice(0, 120)}`);
  }
  return converted;
}

const markdownAll = (values) => values.map(markdown);

/** `{k, v}` pairs, as the client's `{term, detail}`. */
const terms = (list) => list.map(({ k, v }) => ({ term: markdown(k), detail: markdown(v) }));

// ── Ids ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A pick-list id from its display name.
 *
 * The design carries the two pick lists as bare strings, so the ids the client stores have to be
 * derived. The rule: drop everything from the first `/`, `&`, `(` or `…` — the part after those is
 * an alternative or an aside, not identity — then fold diacritics and slugify. `Metro / subway`
 * becomes `metro`, `Cafés & coffee` becomes `cafes`, `E-scooter (Lime, Bird)` becomes `e-scooter`.
 *
 * One exception, and it is in the table rather than the rule because a rule general enough to cover
 * it would swallow real words: `Ride-hailing app` is `ride-hailing`. `test/content.test.ts` pins
 * every id against the client's own corpus, so a change to either side of this shows up as a
 * failure rather than as a silently different id on a stored expense.
 */
const PICKLIST_ID_EXCEPTIONS = new Map([['Ride-hailing app', 'ride-hailing']]);

function picklistId(name) {
  const exception = PICKLIST_ID_EXCEPTIONS.get(name);
  if (exception !== undefined) return exception;

  const head = name.split(/[/&(…]/)[0];
  const slug = head
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');

  if (slug === '') throw new Error(`no id could be derived from "${name}"`);
  return slug;
}

const numbered = (prefix, index, width = 2) =>
  `${prefix}${String(index + 1).padStart(width, '0')}`;

/**
 * The one pick-list option that asks the user to type what the expense actually was.
 *
 * The design decides this **at render time**, with `/something else/i` tested against the selected
 * option's English text — which stops working the moment the list is translated, and would quietly
 * turn the one option whose behaviour differs into an ordinary option for every Arabic reader. iOS
 * ADR-0033 recorded that as a [FIX] and made it a flag on the option. So the design's rule runs
 * here, once, against the English source it was written for, and what ships is the answer.
 *
 * Written only where it is true, because the client decodes it as `decodeIfPresent ?? false` and 41
 * explicit `false`s would be 41 chances to disagree with the one that matters.
 */
const opensFreeText = (name) => /something else/i.test(name);

const option = (name) => ({
  id: picklistId(name),
  name,
  ...(opensFreeText(name) ? { opensFreeText: true } : {}),
});

// ── Currency exponents ────────────────────────────────────────────────────────────────────────

/**
 * ISO 4217 minor units, for the codes that are not 2.
 *
 * The design's currency list carries code, name and symbol only, but `Money.minor` is a count of
 * the smallest unit and every boundary in the system depends on knowing how many there are
 * (invariant 1, ADR-0001). It is never guessed: an unlisted code takes 2, and `assertExponents`
 * below refuses to write a file where a listed code is missing from the design's list — which is
 * how a currency being dropped from the design surfaces here rather than as a factor-of-ten error
 * in somebody's salary.
 */
const EXPONENT_0 = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];
const EXPONENT_3 = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];

function exponentFor(code) {
  if (EXPONENT_0.includes(code)) return 0;
  if (EXPONENT_3.includes(code)) return 3;
  return 2;
}

function assertExponents(currencies) {
  const present = new Set(currencies.map((currency) => currency.code));
  const unknown = [...EXPONENT_0, ...EXPONENT_3].filter((code) => !present.has(code));
  if (unknown.length > 0) {
    throw new Error(
      `the exponent table names currencies the design's list does not carry: ${unknown.join(', ')}. ` +
        'Either the design dropped a currency or the table has a typo; both change what `minor` means.',
    );
  }
}

// ── The curriculum ────────────────────────────────────────────────────────────────────────────

/** The design's four step kinds, as the client's discriminator. */
const STEP_KINDS = { teach: 'teach', choice: 'singleChoice', num: 'numeric', multi: 'multiSelect' };

function step(source) {
  if (source.t === 'teach') {
    return {
      kind: 'teach',
      heading: markdown(source.h),
      paragraphs: markdownAll(source.p),
      ...(source.list ? { list: terms(source.list) } : {}),
      // Paragraphs the design places *after* the definition list, which the client draws in that
      // order — so they cannot be folded into `paragraphs`.
      ...(source.p2 ? { afterList: markdownAll(source.p2) } : {}),
      ...(source.eg ? { example: { heading: markdown(source.eg.h), body: markdown(source.eg.p) } } : {}),
      ...(source.tip ? { tip: markdown(source.tip) } : {}),
    };
  }

  const kind = STEP_KINDS[source.kind];
  if (kind === undefined) throw new Error(`unknown step kind: ${JSON.stringify(source.kind)}`);

  const common = { kind, prompt: markdown(source.q), explanation: markdown(source.why) };

  if (kind === 'numeric') {
    if (typeof source.correct !== 'number') {
      throw new Error(`numeric step has a non-numeric answer: ${JSON.stringify(source.correct)}`);
    }
    // `showsCurrencySymbol` rather than `prefix`: it says what the field does, and the client's
    // field is the one place a currency symbol appears in a lesson.
    return { ...common, answer: source.correct, showsCurrencySymbol: source.prefix === true };
  }

  const answers = Array.isArray(source.correct) ? source.correct : [source.correct];
  if (kind === 'singleChoice' && answers.length !== 1) {
    throw new Error(`a single-choice step has ${String(answers.length)} answers: ${common.prompt}`);
  }
  for (const index of answers) {
    if (!Number.isInteger(index) || index < 0 || index >= source.a.length) {
      throw new Error(`answer index ${String(index)} is outside the options for: ${common.prompt}`);
    }
  }
  return { ...common, options: markdownAll(source.a), answers };
}

const curriculumFrom = (units) => ({
  units: units.map((unit) => ({
    id: unit.id,
    number: unit.n,
    accent: unit.accent,
    title: unit.title,
    subtitle: unit.subtitle,
    blurb: unit.blurb,
    lessons: unit.lessons.map((lesson, lessonIndex) => ({
      id: lesson.id,
      // The design leaves a lesson's number implicit in its position; the client draws it.
      number: lessonIndex + 1,
      icon: lesson.icon,
      title: lesson.title,
      blurb: lesson.blurb,
      steps: lesson.steps.map(step),
    })),
  })),
});

// ── Articles ──────────────────────────────────────────────────────────────────────────────────

const section = (source) => ({
  heading: markdown(source.h),
  ...(source.p ? { paragraphs: markdownAll(source.p) } : {}),
  ...(source.list ? { entries: terms(source.list) } : {}),
  ...(source.steps ? { steps: markdownAll(source.steps) } : {}),
  ...(source.callout ? { callout: markdown(source.callout) } : {}),
});

const articlesFrom = (articles) => ({
  articles: articles.map((article) => ({
    id: article.id,
    // The teaser fields. Kept on the body document rather than in a second file so that one article
    // is one object: `GET /v1/content/articles` projects the teaser, `/articles/:id` serves the lot.
    icon: article.icon,
    short: article.short,
    title: markdown(article.title),
    lede: markdown(article.lede),
    sections: article.sections.map(section),
    sources: article.sources.map(({ t, u }) => ({ title: t, url: u })),
  })),
});

// ── The files ─────────────────────────────────────────────────────────────────────────────────

function build(design) {
  const currencies = design.CURRENCIES.map(({ c, n, s }) => ({
    code: c,
    name: n,
    symbol: s,
    exponent: exponentFor(c),
  }));
  assertExponents(currencies);

  return {
    'tips.en.json': {
      tips: design.TIPS.map((text, index) => ({ id: numbered('tip-', index), text: markdown(text) })),
    },
    'articles.en.json': articlesFrom(design.ARTICLES),
    'curriculum.en.json': curriculumFrom(design.CURRICULUM),
    'security-questions.en.json': {
      // `sq01`…`sq14` are opaque, stable ids. The English text is display content and never an
      // identifier — a stored answer hash is keyed by the id, so re-wording a question must not
      // orphan it (DATA_MODEL §3.1).
      questions: design.QUESTIONS.map((text, index) => ({ id: numbered('sq', index), text })),
    },
    'picklists.json': {
      transport: design.TRANSPORT.map(option),
      other: design.OTHER.map(option),
    },
    'reference/countries.json': {
      countries: design.COUNTRIES.map(({ c, d, n }) => ({ code: c, dialCode: d, name: n })),
    },
    'reference/currencies.json': { currencies },
    'reference/languages.json': {
      // All 87 are retained because the design's picker lists them; `shipped` is what the client
      // filters on, and only English and Arabic are translated (BACKEND_PLAN §7).
      languages: design.LANGUAGES.map(({ c, n, v }) => ({
        code: c,
        name: n,
        nativeName: v,
        shipped: c === 'en' || c === 'ar',
      })),
    },
  };
}

/** Every count from BACKEND_PLAN §4 slice 1, asserted here as well as in the test suite. */
function assertCounts(files) {
  const curriculum = files['curriculum.en.json'];
  const lessons = curriculum.units.flatMap((unit) => unit.lessons);
  const steps = lessons.flatMap((lesson) => lesson.steps);
  const kindCount = (kind) => steps.filter((s) => s.kind === kind).length;

  const expected = [
    ['tips', files['tips.en.json'].tips.length, 49],
    ['articles', files['articles.en.json'].articles.length, 3],
    ['units', curriculum.units.length, 5],
    ['lessons', lessons.length, 15],
    ['steps', steps.length, 124],
    ['teach steps', kindCount('teach'), 58],
    ['question steps', steps.length - kindCount('teach'), 66],
    ['single-choice steps', kindCount('singleChoice'), 50],
    ['numeric steps', kindCount('numeric'), 14],
    ['multi-select steps', kindCount('multiSelect'), 2],
    ['countries', files['reference/countries.json'].countries.length, 251],
    ['currencies', files['reference/currencies.json'].currencies.length, 160],
    ['languages', files['reference/languages.json'].languages.length, 87],
    ['transport modes', files['picklists.json'].transport.length, 22],
    ['other types', files['picklists.json'].other.length, 20],
    ['security questions', files['security-questions.en.json'].questions.length, 14],
  ];

  const wrong = expected
    .filter(([, actual, target]) => actual !== target)
    .map(([label, actual, target]) => `  ${label}: ${String(actual)}, expected ${String(target)}`);

  if (wrong.length > 0) {
    throw new Error(`the extraction lost or gained content:\n${wrong.join('\n')}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────

const files = build(readDesign());
assertCounts(files);

let drifted = 0;
for (const [name, value] of Object.entries(files)) {
  const target = path.join(contentDir, name);
  const serialised = `${JSON.stringify(value, null, 2)}\n`;

  if (checkOnly) {
    let current;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== serialised) {
      console.error(`drift: ${name} differs from what the design extracts to`);
      drifted++;
    }
    continue;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, serialised);
  console.log(`wrote content/${name}`);
}

if (checkOnly) {
  if (drifted > 0) {
    console.error(`\n${String(drifted)} file(s) differ. Run: npm run content:extract`);
    process.exit(1);
  }
  console.log('content/ matches the design');
}
