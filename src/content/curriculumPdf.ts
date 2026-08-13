import PDFDocument from 'pdfkit';

import { getContent, type Language, type LessonStep } from '../content';
import { currencyToken, tokenGap } from '../domain/money';

/**
 * The curriculum as a PDF — **what the reader takes away offline** (iOS ADR-0019).
 *
 * ADR-0019 removed offline lessons from the app and gave that job to this file. So it is not a nicety: it
 * is the whole of the app's offline story, and the reason the client links to it from Learn.
 *
 * **Rendered per currency, not per user.** The `{c}` tokens have to resolve to something, and the reader's
 * display currency is the honest choice — but the output depends on nothing else about them, so it is
 * cacheable per (language, currency) rather than private. That is the same argument invariant 8 makes about
 * `/v1/content/*`, and it is why this route is the one authenticated content route that may still be cached
 * publicly: two readers with the same currency get the same bytes.
 *
 * **Generated on demand rather than at build time.** 5 units × 15 lessons × 124 steps is a few hundred
 * kilobytes and about a second of CPU; caching the bytes per (language, currency) pair costs 160 entries in
 * the worst case, and generating on demand means a content change is live with the deploy rather than
 * needing a build step nobody remembers.
 */

/** The palette, from the workspace's own list — a takeaway should look like the app it came from. */
const GALAXY = '#081F5C';
const PLANETARY = '#334EAC';
const UNIVERSE = '#7096D1';
const INK = '#1A1A1A';
const MUTED = '#5A6A85';

/**
 * Strip the markdown the client renders and the PDF does not.
 *
 * `**bold**` and `*italic*` are dropped rather than reproduced: pdfkit's `text` has no inline styling
 * without splitting every paragraph into runs, and a takeaway document reads perfectly well without it.
 * The alternative — leaving the asterisks in — would put literal `**` in front of a reader.
 */
const plain = (text: string): string => text.replaceAll(/\*\*/g, '').replaceAll('*', '');

/** Resolve `{c}` for the reader's currency, gap included, exactly as the app does. */
function resolveTokens(text: string, currency: string): string {
  const token = currencyToken(currency);
  return plain(text).replaceAll('{c}', `${token}${tokenGap(token)}`);
}

/**
 * Render the whole curriculum.
 *
 * Returns a `Buffer` rather than streaming, because the client downloads it to a file in one go and the
 * document has to be complete before its length is known — a streamed response with no `Content-Length`
 * gives the reader no progress bar on the one screen where they are waiting.
 */
export async function renderCurriculumPdf(language: Language, currency: string): Promise<Buffer> {
  const content = getContent(language);
  const curriculum = content.curriculum.value;

  const document = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: 'HisaabWise — Money, explained',
      Author: 'HisaabWise',
      Subject: 'The full HisaabWise curriculum',
    },
    // The reader may have VoiceOver or a screen reader on a laptop; a tagged document costs nothing here.
    displayTitle: true,
  });

  const chunks: Buffer[] = [];
  document.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => {
    document.on('end', () => {
      resolve();
    });
  });

  const text = (value: string, options: PDFKit.Mixins.TextOptions = {}): void => {
    document.text(resolveTokens(value, currency), options);
  };

  // ── Cover ───────────────────────────────────────────────────────────────────────────────────
  document.fillColor(GALAXY).fontSize(32).font('Helvetica-Bold');
  document.text('HisaabWise', { align: 'left' });
  document.moveDown(0.2);
  document.fillColor(PLANETARY).fontSize(18).font('Helvetica');
  document.text('Money, explained — the full curriculum');
  document.moveDown(1);

  document.fillColor(MUTED).fontSize(10);
  document.text(
    `${String(curriculum.units.length)} units · ${String(
      curriculum.units.reduce((total, unit) => total + unit.lessons.length, 0),
    )} lessons · figures shown in ${currency}`,
  );
  document.moveDown(1.5);

  // The in-app disclaimer travels with the content: this is education, not regulated financial advice.
  document.fillColor(INK).fontSize(9).font('Helvetica-Oblique');
  document.text(
    'This is general financial education, not regulated financial advice. Figures are illustrative. ' +
      'Sources are official where cited — u.ae and the Central Bank of the UAE Rulebook among them.',
    { align: 'left' },
  );

  for (const unit of curriculum.units) {
    document.addPage();

    document.fillColor(UNIVERSE).fontSize(10).font('Helvetica-Bold');
    document.text(`UNIT ${String(unit.number)}`);
    document.fillColor(GALAXY).fontSize(22).font('Helvetica-Bold');
    text(unit.title);
    document.fillColor(PLANETARY).fontSize(12).font('Helvetica');
    text(unit.subtitle);
    document.moveDown(0.4);
    document.fillColor(INK).fontSize(10.5).font('Helvetica');
    text(unit.blurb);

    for (const lesson of unit.lessons) {
      document.moveDown(1);
      document.fillColor(PLANETARY).fontSize(14).font('Helvetica-Bold');
      text(`${String(unit.number)}.${String(lesson.number)}  ${lesson.title}`);
      document.fillColor(MUTED).fontSize(10).font('Helvetica-Oblique');
      text(lesson.blurb);
      document.moveDown(0.3);

      for (const step of lesson.steps) writeStep(document, step, text);
    }
  }

  document.end();
  await finished;
  return Buffer.concat(chunks);
}

/** One step. Questions carry their answer and explanation, because this is a study document. */
function writeStep(
  document: PDFKit.PDFDocument,
  step: LessonStep,
  text: (value: string, options?: PDFKit.Mixins.TextOptions) => void,
): void {
  document.moveDown(0.5);

  if (step.kind === 'teach') {
    document.fillColor(INK).fontSize(11.5).font('Helvetica-Bold');
    text(step.heading);
    document.fontSize(10.5).font('Helvetica');
    for (const paragraph of step.paragraphs) {
      document.moveDown(0.25);
      text(paragraph);
    }

    if (step.list !== undefined) {
      for (const item of step.list) {
        document.moveDown(0.25);
        document.font('Helvetica-Bold');
        text(`  ${item.term}`, { continued: true });
        document.font('Helvetica');
        text(` — ${item.detail}`);
      }
    }

    for (const paragraph of step.afterList ?? []) {
      document.moveDown(0.25);
      text(paragraph);
    }

    if (step.example !== undefined) {
      document.moveDown(0.4);
      document.fillColor(PLANETARY).font('Helvetica-Bold').fontSize(10);
      text(step.example.heading);
      document.fillColor(INK).font('Helvetica').fontSize(10);
      text(step.example.body);
    }

    if (step.tip !== undefined) {
      document.moveDown(0.4);
      document.fillColor(UNIVERSE).font('Helvetica-Oblique').fontSize(10);
      text(`Tip — ${step.tip}`);
      document.fillColor(INK);
    }
    return;
  }

  document.fillColor(GALAXY).fontSize(11).font('Helvetica-Bold');
  text(`Question — ${step.prompt}`);
  document.fillColor(INK).fontSize(10).font('Helvetica');

  if (step.kind === 'numeric') {
    document.moveDown(0.2);
    text(`Answer: ${String(step.answer)}`);
  } else {
    step.options.forEach((option, index) => {
      const isAnswer = step.answers.includes(index);
      document.moveDown(0.15);
      document.font(isAnswer ? 'Helvetica-Bold' : 'Helvetica');
      text(`  ${isAnswer ? '✓' : '·'} ${option}`);
    });
    document.font('Helvetica');
  }

  document.moveDown(0.2);
  document.fillColor(MUTED).fontSize(9.5);
  text(`Why — ${step.explanation}`);
  document.fillColor(INK);
}
