# ADR-0008 — Content is bundled into the Worker, not stored in MongoDB; step count is 124

**Status:** accepted
**Supersedes:** Technical Spec §4 (drops the `content` collection), §9 (`npm run seed` no longer loads content), Product Spec §3.5 and §6 ("~115 steps" → 124)
**Relates to:** workspace invariants 8 and 9

## Context

Technical Spec §4 lists a `content` collection and §9 has `npm run seed` load it. But that
content is static, versioned in-repo, identical for every user, and sits on the four *most*
cacheable endpoints in the API. Serving it from Mongo means a database round trip and an
Atlas connection for exactly the requests that need neither — spending the resource
invariant 9 exists to conserve.

Separately, the content acceptance counts are a CI gate: `DEVELOPMENT_PLAN.md` §8 calls
content extraction the "highest risk of silent error" and says "the counts are the test". One
of them is wrong. Both specs and the workspace CLAUDE.md say "~115 steps"; the prototype
actually contains **124** (58 teach + 66 question). The "115" is a stale comment in the
prototype's own source that the specs copied. The question kinds do reconcile: 50 choice +
14 numeric + 2 multi = 66.

## Decision

**Bundle `content/` into the Worker as imported JSON modules; drop the `content`
collection.** Content ships with the deploy, so it is atomically versioned with the code that
reads it; the ETag derives from the content version. `GET /v1/content/*` and
`GET /v1/curriculum` need zero database access, which serves invariant 9 directly and keeps
invariant 8's cacheable set genuinely cheap. `npm run seed` stops existing for content.

**Assert content counts exactly, not as a range:**

| File | Assertion |
|---|---|
| `tips.en.json` | 49 |
| `articles.en.json` | 3 |
| `curriculum.en.json` | 5 units / 15 lessons / **124 steps = 58 teach + 66 question** |
| question kinds | 50 choice + 14 numeric + 2 multi |
| `reference/countries.json` | 251 |
| `reference/currencies.json` | 160 (matching the 160 FX codes exactly) |
| `reference/languages.json` | 87 retained |
| `picklists.json` | 22 transport, 20 other |
| security questions | 14 |

Exact equality, with the step count **decomposed**. `~115` would let a lossy extraction pass
silently, and a single total can hide an off-by-one that swapped a teach step for a question.

**Verify the Worker bundle size against the 10 MB gzipped ceiling** as a build check rather
than an assumption. The entire design HTML is ~700 KB including all markup and CSS, so this
is expected to be comfortable, but it is measured.

## Consequences

- The most-requested endpoints need no Atlas connection at all, which materially reduces the
  connection pressure `DEVELOPMENT_PLAN.md` §8 calls the one genuinely new operational risk.
- Content can only change by deploying. That is a feature: content and the code reading it
  can never disagree, and a content fix is auditable in git.
- Deviates from Technical Spec §4's eleven collections and §9's seed verification step. Both
  need amending. The remaining ten collections are unaffected.
- Localisation (`en` + `ar`) means two content sets in the bundle. Still small.
- The "115" figure must be corrected in Product Spec §3.5 and §6, Technical Spec §9, and the
  workspace CLAUDE.md content table, or CI and the docs will contradict each other.
