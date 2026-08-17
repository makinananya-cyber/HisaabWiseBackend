import { ApiError } from '../errors';

import type { Language } from '../content';

/**
 * The curriculum PDF renderer, behind an interface, because pdfkit does not run on Workers.
 *
 * `src/content/curriculumPdf.ts` is built on pdfkit, which reads its AFM font metrics from disk and
 * writes through Node streams. Neither exists under workerd, and unlike argon2 there is no drop-in
 * WebAssembly substitute worth adopting for one endpoint.
 *
 * Rather than pretend otherwise, the Workers deployment installs `unavailableRenderer` and
 * `GET /v1/content/curriculum/pdf` answers 501 with a message that says why. Every other route in
 * the service is unaffected.
 *
 * **The better answer, when this matters:** the curriculum is static, versioned content, so the PDF
 * can be generated once at build time and served as a static asset or from R2 instead of being
 * rendered per request. That would be an improvement on Node too — it is rendering the same bytes
 * for every caller of a given language and currency. It is out of scope here because it changes
 * what the endpoint *is* rather than where it runs.
 */
export type PdfRenderer = (language: Language, currency: string) => Promise<Buffer>;

let renderer: PdfRenderer | undefined;

/** Install the runtime's renderer. Called from the entrypoint. */
export function setPdfRenderer(next: PdfRenderer): void {
  renderer = next;
}

/**
 * The renderer a Worker installs: an honest 501 rather than a 500 from a library that cannot load.
 *
 * 501 and not 404, because the route exists and the client's request was well formed — what is
 * missing is an implementation on this deployment, which is exactly what 501 means.
 */
export const unavailableRenderer: PdfRenderer = () => {
  throw new ApiError(
    'NOT_IMPLEMENTED',
    'The curriculum PDF needs pdfkit, which cannot run on Cloudflare Workers.',
  );
};

export function renderPdf(language: Language, currency: string): Promise<Buffer> {
  if (!renderer) {
    throw new Error(
      'No PDF renderer is installed. Call setPdfRenderer() from the entrypoint — ' +
        'renderCurriculumPdf on Node, unavailableRenderer on Cloudflare Workers.',
    );
  }
  return renderer(language, currency);
}
