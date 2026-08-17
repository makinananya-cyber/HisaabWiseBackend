import { Hono, type Context } from 'hono';

import { getContent, resolveLanguage, type ContentResource } from '../content';
import type { AppEnv } from '../types/hono';

/**
 * The cacheable half of the API (invariant 8).
 *
 * Every route here answers with bytes that are **identical for every user**, which is exactly what
 * makes them safe to cache at the edge and to store on the device. Nothing per-user may ever move
 * into this file: a cache HIT on per-user data is a data breach, not a performance win.
 *
 * Two path families, and the split is deliberate rather than accidental (iOS `Endpoint.swift`):
 * `/v1/content/*` is ancillary content, and `/v1/curriculum` sits on its own root because the
 * curriculum is the product — the PDF and any per-unit variants hang off the same path, and burying
 * them under `content` would make `/v1/content/curriculum/pdf` the address of the headline feature.
 *
 * **Unauthenticated, on purpose.** Registration needs the country, currency and security-question
 * lists before an account exists, so requiring a token here would be a chicken-and-egg problem
 * dressed up as security. There is nothing here to protect.
 */

/**
 * How long a content response may be reused before it must be revalidated.
 *
 * Five minutes, and the number is a content-propagation budget rather than a performance one: an
 * editor who fixes a typo should see it live in minutes, and the client revalidates with its stored
 * ETag on every load anyway, so a longer window would buy the edge cache very little and cost
 * correctness after a deploy. `must-revalidate` forbids serving a stale copy after that window even
 * if the origin is unreachable — content is small and always available, so guessing is unnecessary.
 */
const CACHE_CONTROL = 'public, max-age=300, must-revalidate';

/**
 * Answer with a content resource, honouring `If-None-Match`.
 *
 * A `304` carries the ETag and the caching headers and **no body**, which is the whole point: the
 * client's `ContentLoader` stores bytes plus their ETag and revalidates on every load, so the steady
 * state for the 251-country list is an empty response rather than 8 KB.
 *
 * `Vary: Accept-Language` is set on both paths. Arabic is not translated yet, so every language
 * resolves to English today — but a cache keyed without `Vary` would go on serving those English
 * bytes to Arabic readers on the day it lands, and that is a bug you cannot fix by deploying
 * content.
 *
 * The comparison is a **list** membership test, not equality: a conditional request may legitimately
 * carry several ETags, and `*` means "any representation I might have".
 */
function headersFor<Value>(resource: ContentResource<Value>): Record<string, string> {
  return {
    ETag: resource.etag,
    'Cache-Control': CACHE_CONTROL,
    Vary: 'Accept-Language',
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

/**
 * Whether the client already holds these exact bytes.
 *
 * A **list** membership test rather than equality: a conditional request may legitimately carry
 * several tags, and `*` means "any representation I might have". A cache may also weaken a strong
 * tag on the way back out, and `W/"x"` and `"x"` describe the same bytes for the purpose of "have
 * these changed", so the prefix is stripped before comparing.
 */
function alreadyHeld(ifNoneMatch: string | undefined, etag: string): boolean {
  const presented = (ifNoneMatch ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .map((tag) => (tag.startsWith('W/') ? tag.slice(2) : tag))
    .filter((tag) => tag.length > 0);

  return presented.includes('*') || presented.includes(etag);
}

/** Answer with a content resource, or a bodiless `304` if the client already has it. */
function respond<Value>(c: Context<AppEnv>, resource: ContentResource<Value>): Response {
  const headers = headersFor(resource);
  if (alreadyHeld(c.req.header('if-none-match'), resource.etag)) return c.body(null, 304, headers);
  return c.body(resource.body, 200, headers);
}

/** Register one content route serving the resource the language resolves to. */
function serve<Value>(
  app: Hono<AppEnv>,
  routePath: string,
  pick: (content: ReturnType<typeof getContent>) => ContentResource<Value>,
): void {
  app.get(routePath, (c) => respond(c, pick(getContent(resolveLanguage(c.req.header('accept-language'))))));
}

export const contentRoutes = new Hono<AppEnv>();

serve(contentRoutes, '/v1/content/tips', (content) => content.tips);
serve(contentRoutes, '/v1/content/articles', (content) => content.articleTeasers);
serve(contentRoutes, '/v1/content/picklists', (content) => content.picklists);
serve(contentRoutes, '/v1/content/reference/countries', (content) => content.countries);
serve(contentRoutes, '/v1/content/reference/currencies', (content) => content.currencies);
serve(contentRoutes, '/v1/content/reference/languages', (content) => content.languages);
serve(contentRoutes, '/v1/content/security-questions', (content) => content.securityQuestions);
serve(contentRoutes, '/v1/curriculum', (content) => content.curriculum);

/**
 * One article's body.
 *
 * Separate from the teaser list and separately ETagged, because a body is what the reader waited for
 * and the teasers are what Home already carries. An unknown id is a `404` rather than an empty
 * document: the client builds this path from an id in a payload it was given, so a miss means the
 * content and the payload disagree, and that is worth surfacing.
 */
contentRoutes.get('/v1/content/articles/:id', (c) => {
  const language = resolveLanguage(c.req.header('accept-language'));
  const resource = getContent(language).articleById.get(c.req.param('id'));

  if (resource === undefined) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'No such article' } }, 404);
  }

  return respond(c, resource);
});
