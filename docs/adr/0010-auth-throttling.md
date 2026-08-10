# ADR-0010 — Per-account lockout lives in MongoDB; IP throttling is a separate layer

**Status:** accepted
**Relates to:** Product Spec §3.2, Technical Spec §5, workspace Rule 7

## Context

Two different mechanisms were conflated. Technical Spec §5 specifies "Cloudflare WAF rules on
`/v1/auth/*` AND in-app rate limiting" — both **volumetric, IP-keyed**. But Product Spec
§3.2's "after 3 failed attempts, suggest contacting support, server-side backoff" is
**per-account** counting, which an IP-keyed limiter structurally cannot do: three failures
against one account from three different networks look like three unrelated requests.

There is also a sequencing problem. Rule 7 defers all Cloudflare edge configuration until the
API keys arrive, but Phase 1 ships the entire auth surface. Without a decision, Phase 1 has
no throttling at all.

## Decision

**Per-account state in MongoDB now.** `failedLoginCount` and `lockedUntil` on the user
document, updated atomically via `findOneAndUpdate`. One write per **failed** login, which is
negligible, and it needs no new infrastructure.

**IP-keyed volumetric throttling via the native Workers rate-limiting binding**, layered
beneath it.

**Cloudflare WAF as a third layer** once keys arrive — defence in depth, per Technical
Spec §5, not the primary mechanism.

**Escalation path:** a Durable Object per email if Mongo write volume or contention becomes a
problem. Better isolated, but machinery not yet needed.

**Do not leak account existence.** Count only for accounts that exist, and keep the response
body and timing identical for accounts that do not — otherwise the lockout itself becomes the
enumeration oracle that [ADR-0004](0004-identity-and-credentials.md) declined to build as an
endpoint.

## Consequences

- Phase 1 ships with real per-account throttling rather than waiting on credentials that are
  outside the team's control.
- Product Spec §3.2's stated behaviour becomes implementable as written, instead of
  approximated by an IP limiter that would lock out an entire office NAT.
- A failed login now costs a database write. Accepted: failed logins are rare relative to
  successful ones, and the write is a single atomic update.
- Equal-timing responses for non-existent accounts require care — the argon2 verify must run
  against a dummy hash rather than being skipped, or the timing difference restores the
  oracle.
