import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getContent } from '../src/content';
import { assertMatchesShape } from './contract/shape';
import { testApp } from './support/app';
import { required } from './support/expect';

/**
 * Slice 1's integration test — the one the contract manifest's `live` entries stand behind.
 *
 * Driven through `app.request()` so routing, the middleware chain, the caching headers and the
 * serialised body are all covered. Each payload is checked against the client's own fixture with
 * `assertMatchesShape`, which is the definition of done `BACKEND_PLAN.md` §1.1 sets: same keys, same
 * types, same enum values — figures not asserted, because a fixture's figures are one user's data.
 */

const app = testApp();
const content = getContent('en');

const corpusDir = path.join(import.meta.dirname, 'contract', 'corpus');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(corpusDir, name), 'utf8'));

/** Every content route, with the fixture that describes its payload. */
const routes = [
  { path: '/v1/content/tips', fixture: 'tips.json' },
  { path: '/v1/curriculum', fixture: 'curriculum.json' },
  { path: '/v1/content/picklists', fixture: 'picklists.json' },
  { path: '/v1/content/reference/countries', fixture: 'reference-countries.json' },
  { path: '/v1/content/reference/currencies', fixture: 'reference-currencies.json' },
  { path: '/v1/content/security-questions', fixture: 'reference-security-questions.json' },
  { path: '/v1/content/articles/scams', fixture: 'article-scams.json' },
] as const;

describe.each(routes)('GET $path', ({ path: routePath, fixture: fixtureName }) => {
  it('satisfies the client contract', async () => {
    const response = await app.request(routePath);

    expect(response.status).toBe(200);
    assertMatchesShape(fixture(fixtureName), await response.json(), `${routePath} against ${fixtureName}`);
  });

  it('is cacheable, revalidatable, and keyed on the reader\'s language', async () => {
    const response = await app.request(routePath);

    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, must-revalidate');
    // Arabic is not translated yet, so every language resolves to English — and this header is what
    // stops an edge cache serving these bytes to an Arabic reader on the day it is.
    expect(response.headers.get('vary')).toBe('Accept-Language');
  });

  it('answers 304 with no body when the client already has these bytes', async () => {
    const first = await app.request(routePath);
    const etag = required(first.headers.get('etag'), `an ETag on ${routePath}`);

    const second = await app.request(routePath, { headers: { 'If-None-Match': etag } });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    // The ETag is repeated on the 304, because the client stores it alongside the bytes it kept.
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('answers 200 when the client has different bytes', async () => {
    const response = await app.request(routePath, {
      headers: { 'If-None-Match': '"0123456789abcdef0123456789abcdef"' },
    });

    expect(response.status).toBe(200);
  });
});

describe('conditional requests', () => {
  it('accepts a tag a cache has weakened on the way out', async () => {
    const strong = required((await app.request('/v1/content/tips')).headers.get('etag'), 'the tips ETag');

    const response = await app.request('/v1/content/tips', {
      headers: { 'If-None-Match': `W/${strong}` },
    });

    expect(response.status).toBe(304);
  });

  it('accepts a list of tags, matching any one of them', async () => {
    const etag = required((await app.request('/v1/content/tips')).headers.get('etag'), 'the tips ETag');

    const response = await app.request('/v1/content/tips', {
      headers: { 'If-None-Match': `"deadbeefdeadbeefdeadbeefdeadbeef", ${etag}` },
    });

    expect(response.status).toBe(304);
  });

  it('treats * as "any representation I might have"', async () => {
    const response = await app.request('/v1/content/tips', { headers: { 'If-None-Match': '*' } });

    expect(response.status).toBe(304);
  });

  it('does not confuse one resource\'s tag for another\'s', async () => {
    const tipsETag = required((await app.request('/v1/content/tips')).headers.get('etag'), 'the tips ETag');

    const response = await app.request('/v1/curriculum', {
      headers: { 'If-None-Match': tipsETag },
    });

    expect(response.status).toBe(200);
  });
});

describe('GET /v1/content/articles', () => {
  it('lists the three teasers without their bodies', async () => {
    const response = await app.request('/v1/content/articles');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { articles: Record<string, unknown>[] };
    expect(body.articles).toHaveLength(3);
    for (const teaser of body.articles) {
      expect(teaser).toHaveProperty('id');
      expect(teaser).toHaveProperty('title');
      expect(teaser).toHaveProperty('lede');
      expect(teaser).not.toHaveProperty('sections');
    }
  });
});

describe('GET /v1/content/articles/:id', () => {
  it('serves each of the three articles', async () => {
    for (const id of ['scams', 'remit', 'debt']) {
      const response = await app.request(`/v1/content/articles/${id}`);

      expect(response.status, id).toBe(200);
      const body = (await response.json()) as { id: string; sections: unknown[] };
      expect(body.id).toBe(id);
      expect(body.sections.length).toBeGreaterThan(0);
    }
  });

  it('gives each article its own ETag', async () => {
    const etags = await Promise.all(
      ['scams', 'remit', 'debt'].map(async (id) =>
        (await app.request(`/v1/content/articles/${id}`)).headers.get('etag'),
      ),
    );

    expect(new Set(etags).size).toBe(3);
  });

  it('answers 404 in the error envelope for an id the content does not have', async () => {
    const response = await app.request('/v1/content/articles/nonexistent');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such article' },
    });
  });
});

describe('language negotiation', () => {
  it('serves English to a reader asking for a language that is not shipped', async () => {
    const response = await app.request('/v1/content/tips', {
      headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(content.tips.etag);
  });
});

describe('cache safety', () => {
  /**
   * Invariant 8, from the other direction: everything in this file is `public`-cacheable, and the
   * reason that is safe is that none of it is per-user. A route that ever needed a token would
   * belong in a different file, and this assertion is what makes moving one here visible.
   */
  it('serves identical bytes regardless of who asks', async () => {
    const anonymous = await app.request('/v1/content/tips');
    const withToken = await app.request('/v1/content/tips', {
      headers: { Authorization: 'Bearer irrelevant' },
    });

    expect(await anonymous.text()).toBe(await withToken.text());
    expect(withToken.headers.get('cache-control')).toContain('public');
  });
});
