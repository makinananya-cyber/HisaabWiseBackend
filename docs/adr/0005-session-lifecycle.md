# ADR-0005 — Access tokens carry a security epoch; refresh tokens carry a family id

**Status:** accepted
**Supersedes:** Technical Spec §4 (`refresh_tokens` gains `familyId`, `replacedBy`; `users` gains `securityEpoch`)

## Context

Two holes in the specified session design.

**The 15-minute revocation window.** Product Spec §3.7 says a password change "revokes all
other sessions", but an access JWT is self-contained — a revoked session keeps working until
it expires. The Phase 1 exit gate ("password change kills another device's refresh token")
only tests the refresh token, so this hole would pass the gate unnoticed.

**No way to identify a token family.** Technical Spec §5 requires "reuse of a revoked token
revokes the whole family", but §4's `refresh_tokens` fields — `userId, tokenHash, deviceId,
expiresAt, revokedAt` — contain nothing identifying a family. `deviceId` cannot serve: it
comes from the client and is spoofable, so an attacker would simply send a different one.

## Decision

**Add `users.securityEpoch`,** an integer, incremented on password change, `logout-all`, and
account deletion. It is minted into every access token as a `sec` claim; auth middleware
rejects a mismatch. This is nearly free in practice — almost every authenticated route
already loads the user document for timezone and display currency.

**Add `refresh_tokens.familyId` and `replacedBy`.** One family per login. Rotation walks the
chain: each use issues a new token, sets `revokedAt` and `replacedBy` on the old one.
Presenting a token whose `revokedAt` is already set revokes **every** token sharing its
`familyId`.

**`deviceId` is a display label only** — for "sign out other devices" in the UI — never a
security boundary.

**Token hashing:** SHA-256, per [ADR-0004](0004-identity-and-credentials.md).

## Consequences

- Revocation is immediate rather than eventually-consistent within 15 minutes. A stolen
  access token dies the moment the user changes their password, which is the action a user
  takes precisely *because* they think they have been compromised.
- The auth middleware now depends on a user-document read. Accepted: it already needed one.
  Routes that genuinely need no user document are rare and can opt out explicitly.
- Family revocation is now implementable, so Technical Spec §5's stated requirement stops
  being aspirational.
- `securityEpoch` must be incremented in exactly one place (a repository method), or a new
  revocation path will forget it. Enforced by keeping the increment inside the repository
  that owns password and deletion writes.
