# API contract

Every error response in this service uses one envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

The versioned `/v1` contract — including every route that returns `501` until it is implemented
— lands with its own ticket and will be documented here alongside the operational endpoints
below.

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
