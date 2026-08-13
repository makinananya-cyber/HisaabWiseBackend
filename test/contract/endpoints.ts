/**
 * The `/v1` surface, and which slice owns each endpoint.
 *
 * This is a curated list rather than an extracted one, because it carries information the client
 * source cannot: which slice implements the endpoint, and which fixtures describe its payload.
 * Extraction is still the authority on *existence* — `contract.test.ts` requires every `/v1`
 * literal in the synced corpus manifest to be covered here, so a path the client starts calling
 * cannot go unnoticed.
 *
 * `status` is the honest project tracker. Flip an entry to `'live'` in the same commit that
 * implements it, and the contract test starts asserting its payload against the fixtures.
 */

export type Slice = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface EndpointContract {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The route as registered, with `:params`. */
  readonly path: string;
  readonly slice: Slice;
  /** Fixtures describing this payload. Empty where no payload has a fixture (writes, binaries). */
  readonly fixtures: readonly string[];
  readonly status: 'pending' | 'live';
  /** Why there is no fixture, where there is none. */
  readonly note?: string;
}

export const endpoints: readonly EndpointContract[] = [
  // ── Slice 1 — content and reference data ────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/content/tips', slice: 1, fixtures: ['tips.json'], status: 'live' },
  {
    method: 'GET',
    path: '/v1/content/articles',
    slice: 1,
    fixtures: [],
    status: 'live',
    note: 'Teaser list; the teasers the client renders are inline in the Home payload, and the bodies are fetched per id.',
  },
  {
    method: 'GET',
    path: '/v1/content/articles/:id',
    slice: 1,
    fixtures: ['article-scams.json'],
    status: 'live',
  },
  { method: 'GET', path: '/v1/curriculum', slice: 1, fixtures: ['curriculum.json'], status: 'live' },
  {
    method: 'GET',
    path: '/v1/content/picklists',
    slice: 1,
    fixtures: ['picklists.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/content/reference/countries',
    slice: 1,
    fixtures: ['reference-countries.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/content/reference/currencies',
    slice: 1,
    fixtures: ['reference-currencies.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/content/security-questions',
    slice: 1,
    fixtures: ['reference-security-questions.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/content/reference/languages',
    slice: 1,
    fixtures: [],
    status: 'live',
    note: 'All 87 languages with a `shipped` flag. No fixture: the client\'s picker is built from `AppLanguage`, so nothing decodes this yet — it exists so the list has one owner when the picker does read it.',
  },

  // ── Slice 2 — identity ──────────────────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/v1/auth/register',
    slice: 2,
    fixtures: ['session-tokens.json'],
    status: 'live',
  },
  {
    method: 'POST',
    path: '/v1/auth/login',
    slice: 2,
    fixtures: ['session-tokens.json'],
    status: 'live',
  },
  {
    method: 'POST',
    path: '/v1/auth/refresh',
    slice: 2,
    fixtures: ['session-tokens.json'],
    status: 'live',
  },
  {
    method: 'POST',
    path: '/v1/auth/logout',
    slice: 2,
    fixtures: ['logout-acknowledged.json'],
    status: 'live',
  },
  {
    method: 'POST',
    path: '/v1/auth/logout-all',
    slice: 2,
    fixtures: ['logout-acknowledged.json'],
    status: 'live',
  },
  {
    method: 'POST',
    path: '/v1/auth/forgot-password/questions',
    slice: 2,
    fixtures: [],
    status: 'live',
    note: 'Recovery by security question, decided 13 Aug 2026. The client screen is an unbuilt placeholder, so there is no fixture yet — this backend defines the shape and the iOS slice follows it: {questions: [{id, text}, {id, text}]}.',
  },
  {
    method: 'POST',
    path: '/v1/auth/forgot-password/verify',
    slice: 2,
    fixtures: [],
    status: 'live',
    note: 'Email + both answers + DOB → {ticket, expiresInSeconds}, single use.',
  },
  {
    method: 'POST',
    path: '/v1/auth/reset-password',
    slice: 2,
    fixtures: [],
    status: 'live',
    note: 'Ticket + newPassword → {}. Revokes every family and bumps securityEpoch.',
  },
  {
    method: 'GET',
    path: '/v1/me',
    slice: 2,
    fixtures: ['me-verified.json', 'me-unverified.json'],
    status: 'live',
  },
  {
    method: 'PUT',
    path: '/v1/me/language',
    slice: 2,
    fixtures: ['language-english.json', 'language-arabic.json'],
    status: 'live',
  },
  {
    method: 'PUT',
    path: '/v1/me/timezone',
    slice: 2,
    fixtures: [],
    status: 'live',
    note: 'No fixture and no caller: the zone is captured on register, login and refresh (ADR-0023). This exists to correct a stored zone without signing out.',
  },

  // ── Slice 3 — money and Home ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/v1/screens/home',
    slice: 3,
    fixtures: ['home-inr.json', 'home-first-run.json'],
    status: 'live',
    note: 'Two fixtures, two legal shapes: `savings.remaining` is a Money in one and null in the other, which is how the client models it. Spending and Learn standing arrive empty until slices 4 and 5 supply them.',
  },
  {
    method: 'GET',
    path: '/v1/budget',
    slice: 3,
    fixtures: ['budget-inr.json', 'budget-aed.json', 'money-exponents.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/fx/rates',
    slice: 3,
    fixtures: [],
    status: 'live',
    note: 'Newest rate set plus its date; no fixture in the corpus because the client reads rates only through screen payloads. Cacheable — the same rates for everybody (invariant 8).',
  },

  // ── Slice 4 — expenses ──────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/v1/screens/expenses',
    slice: 4,
    fixtures: ['expenses-inr.json', 'expenses-first-run.json', 'expenses-over-budget.json'],
    status: 'live',
  },
  {
    method: 'POST',
    path: '/v1/expenses',
    slice: 4,
    fixtures: ['expenses-inr.json'],
    status: 'live',
    note: 'Answers 201 with the updated screen payload (ADR-0020). The `Idempotency-Key` header IS the document `_id` (ADR-0011), so a replay is a success carrying the current screen rather than a 409.',
  },
  {
    method: 'DELETE',
    path: '/v1/expenses/:id',
    slice: 4,
    fixtures: ['expenses-inr.json'],
    status: 'live',
    note: 'Answers with the updated screen payload. 404 for an unknown id, including another user\'s.',
  },
  {
    method: 'GET',
    path: '/v1/expenses/fixed',
    slice: 4,
    fixtures: ['expenses-inr.json'],
    status: 'live',
    note: 'Answers with the whole screen: the client has no separate model for a fixed-cost fragment.',
  },
  {
    method: 'PUT',
    path: '/v1/expenses/fixed/:categoryId',
    slice: 4,
    fixtures: ['expenses-inr.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/expenses/lines',
    slice: 4,
    fixtures: ['expenses-inr.json'],
    status: 'live',
  },
  {
    method: 'PUT',
    path: '/v1/expenses/lines/:categoryId',
    slice: 4,
    fixtures: ['expenses-inr.json'],
    status: 'live',
    note: 'The whole set, replaced — which is what makes a deleted line expressible. Line ids are server-minted so a rename keeps a line\'s identity.',
  },

  // ── Slice 5 — learn ─────────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/v1/screens/learn',
    slice: 5,
    fixtures: ['learn-first-run.json', 'learn-in-progress.json', 'learn-complete.json'],
    status: 'live',
  },
  {
    method: 'GET',
    path: '/v1/content/curriculum/pdf',
    slice: 5,
    fixtures: [],
    status: 'live',
    note: 'Server-generated PDF (iOS ADR-0019) — a binary, so no JSON fixture. Asserted by the %PDF- magic bytes, a >20 KB body, and a 304 on revalidation. Authenticated but cacheable per (language, currency): the bytes depend on nothing else about the reader.',
  },
  {
    method: 'GET',
    path: '/v1/learn/progress',
    slice: 5,
    fixtures: ['learn-first-run.json'],
    status: 'live',
    note: 'The same payload as the screen — one shape, so the client models nothing extra.',
  },
  {
    method: 'POST',
    path: '/v1/learn/progress',
    slice: 5,
    fixtures: ['learn-in-progress.json'],
    status: 'live',
    note: 'A mid-lesson position. Earns no XP and no streak day; a failure costs the reader the tail of one run.',
  },
  {
    method: 'POST',
    path: '/v1/learn/lessons/:id/complete',
    slice: 5,
    fixtures: ['lesson-completed.json', 'lesson-revisited.json'],
    status: 'live',
    note: 'XP recomputed from the submitted results, first completion only. 422 for an impossible submission (a teach page answered, a question answered twice, a fourth heart used, a question skipped); 403 for a locked lesson.',
  },

  // ── Slice 6 — reports ───────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/v1/screens/reports',
    slice: 6,
    fixtures: ['reports-inr.json', 'reports-two-years.json', 'reports-empty.json'],
    status: 'live',
    note: 'The list scales its trend bars against the newest rate set so the months are comparable; the verdicts still come from the stored documents, so no FX movement can change whether a goal was met.',
  },
  {
    method: 'GET',
    path: '/v1/screens/reports/:monthKey',
    slice: 6,
    fixtures: ['reports-month-inr.json', 'reports-month-aed.json', 'reports-month-quiet.json'],
    status: 'live',
    note: 'Converted through the month\'s **pinned** rate set (invariant 7), so changing display currency converts every figure and changes no verdict.',
  },
  {
    method: 'GET',
    path: '/v1/fx/rates/:monthKey',
    slice: 6,
    fixtures: [],
    status: 'live',
    note: 'The set an archived month was closed with. Immutable, so cacheable for a long time — it is what makes a report\'s figures explicable after a currency change.',
  },

  // ── Slice 7 — account and compliance ────────────────────────────────────────────────────────
  {
    method: 'PUT',
    path: '/v1/me',
    slice: 7,
    fixtures: ['account-inr.json'],
    status: 'pending',
    note: 'The three editable personal details. `PUT`, not the Technical Spec\'s `PATCH`: the design\'s Save button commits the whole card, so there is no partial update to express. In slice 7 rather than slice 2 because it answers with the Account screen payload (ADR-0020), which is built there.',
  },
  {
    method: 'PUT',
    path: '/v1/me/currency',
    slice: 7,
    fixtures: ['account-aed.json'],
    status: 'pending',
    note: 'Answers with the Account screen payload, so it lands with slice 7 rather than slice 2.',
  },
  {
    method: 'POST',
    path: '/v1/me/password',
    slice: 7,
    fixtures: ['account-inr.json'],
    status: 'pending',
    note: 'currentPassword + both security answers + newPassword, in one request. Refusals are 422 INVALID_CREDENTIALS / SECURITY_ANSWERS_INVALID, never 401 — a 401 makes the client spend its refresh token and a mistyped password would end the session. Slice 2 built the mechanism (securityEpoch bump, revokeOtherFamilies); this answers with the Account screen payload, so the route lands with slice 7.',
  },
  {
    method: 'GET',
    path: '/v1/screens/account',
    slice: 7,
    fixtures: ['account-inr.json', 'account-aed.json', 'account-unverified.json'],
    status: 'pending',
  },
  { method: 'GET', path: '/v1/me/export', slice: 7, fixtures: ['me-export.json'], status: 'pending' },
  { method: 'DELETE', path: '/v1/me', slice: 7, fixtures: [], status: 'pending' },
  { method: 'POST', path: '/v1/events', slice: 7, fixtures: [], status: 'pending' },
];

/**
 * `budget-drifted.json` is deliberately unclaimed above: it is a *negative* fixture, a payload with
 * a blank `display` string that the client must refuse. `shape.test.ts` asserts it fails the shape
 * check rather than passing one.
 */
export const negativeFixtures = ['budget-drifted.json'] as const;
