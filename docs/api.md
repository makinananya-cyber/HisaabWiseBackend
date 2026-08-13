# API contract

Every error response in this service uses one envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

The versioned `/v1` contract is delivered slice by slice
([BACKEND_PLAN.md](BACKEND_PLAN.md) §4). Each endpoint's payload shape is defined by the client
fixture that describes it — see [ADR-0017](adr/0017-contract-testing-against-the-ios-corpus.md) — and
`test/contract/endpoints.ts` is the live inventory of what is implemented and what is not.

## Content and reference data — slice 1

Everything under this heading is **cacheable** (invariant 8): the same bytes for every user, no
authentication, no database access. Content is extracted from the design prototype by
`npm run content:extract`, committed under `content/`, and read into memory at startup with its
counts asserted — see [ADR-0008](adr/0008-content-delivery.md), as amended by
[ADR-0016](adr/0016-node-runtime-and-hono-adapter.md).

| Route | Payload | Count |
| --- | --- | --- |
| `GET /v1/content/tips` | `{tips: [{id, text}]}` | 49 |
| `GET /v1/content/articles` | `{articles: [{id, icon, short, title, lede}]}` | 3 teasers |
| `GET /v1/content/articles/:id` | one article with `sections` and `sources` | `scams`, `remit`, `debt` |
| `GET /v1/curriculum` | `{units: [...]}`, answer keys included | 5 units / 15 lessons / 124 steps |
| `GET /v1/content/picklists` | `{transport, other}` | 22 / 20 |
| `GET /v1/content/reference/countries` | `{countries: [{code, dialCode, name}]}` | 251 |
| `GET /v1/content/reference/currencies` | `{currencies: [{code, name, symbol, exponent}]}` | 160 |
| `GET /v1/content/reference/languages` | `{languages: [{code, name, nativeName, shipped}]}` | 87 |
| `GET /v1/content/security-questions` | `{questions: [{id, text}]}` | 14, `sq01`…`sq14` |

**Caching.** Every response carries a strong `ETag`, `Cache-Control: public, max-age=300,
must-revalidate`, and `Vary: Accept-Language`. An `If-None-Match` that matches answers `304` with no
body, which is the steady state for the client's `ContentLoader` — it stores bytes plus their ETag and
revalidates on every load. A conditional request may carry a list of tags or `*`, and a tag a cache
has weakened (`W/"…"`) still matches.

**Language.** `Accept-Language` is honoured with quality ordering and regional fallback (`en-GB` →
`en`). Arabic is not translated yet, so every language resolves to English today; `Vary` is what stops
a cache serving those English bytes to an Arabic reader on the day it lands.

`404`

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | no article with that id |

**Two path roots, deliberately.** `/v1/content/*` is ancillary content; `/v1/curriculum` sits on its
own root because the curriculum is the product — the PDF and any per-unit variants hang off the same
path, and burying them under `content` would make `/v1/content/curriculum/pdf` the address of the
headline feature. Invariant 8 names both as cacheable families, so this is not an exception to one.

`{c}` in any content string is a **currency token**, resolved per user against their display
currency. It is never resolved at extraction time.

## Operational endpoints

These sit outside `/v1`: they are infrastructure, not part of the client API contract. Both
deviate from Technical Spec §5, which specified a single `GET /health` returning
`{"status":"ok","db":true}`. [ADR-0013](adr/0013-operational-endpoints.md) split it, because a
minute-granularity uptime monitor hitting one endpoint that pings the database opens an Atlas
connection per check — spending exactly the resource connection discipline exists to conserve.

### `GET /health`

Shallow liveness. Performs **no** database access. This is what the uptime monitor and the
Cloudflare health check hit.

`200`

```json
{ "status": "ok" }
```

### `GET /health/db`

Deep check. Pings the database and reports whether it is reachable **now** — the result is never
cached and never memoised, so `db: true` cannot mean "was true recently". Responses carry
`Cache-Control: no-store`.

For the Phase 0 exit gate, post-deploy verification, and a low-frequency deep check. Not for a
minute-granularity monitor.

`200`

```json
{ "status": "ok", "db": true }
```

`503`

| Code | Meaning |
| --- | --- |
| `DB_UNAVAILABLE` | the database could not be reached |

There is no `DB_NOT_CONFIGURED` code, and its absence is deliberate. `MONGODB_URI` is validated in
`src/config.ts` and the pool is connected **before the server binds a port**, so a process that is
answering requests at all has a configured, reachable database. Misconfiguration is a failure to
boot, which is strictly better than a failure to serve — the platform health check never goes green
on a process that cannot work.

The underlying driver error goes to the logs, not the response: the endpoint is unauthenticated and
a driver error names cluster hosts.
