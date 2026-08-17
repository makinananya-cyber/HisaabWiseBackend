# ADR-0011 — Idempotency comes from a client-generated document `_id`, not an idempotency-key store

**Status:** accepted
**Relates to:** Technical Spec §5, Product Spec §3.4 (offline queue)

## Context

Technical Spec §5 says write endpoints accept an `Idempotency-Key` header "where retries are
plausible (expense create)", but **nothing in §4 stores keys**. As specified, a retried
offline-queue drain double-writes the expense.

The conventional fix is an `idempotency_keys` collection with a unique `(userId, key)` index,
a stored response snapshot, and a TTL sweep.

## Decision

**Skip the collection: let the client generate the expense's `_id`.**

The offline queue already creates a local entry with a stable local identity. Have it mint a
UUID that becomes the document `_id`. MongoDB's unique `_id` index makes the create idempotent
for free — a duplicate insert raises `E11000`, which the route translates into
"already recorded", returning the existing entry.

`Idempotency-Key` remains accepted as a header alias for the same value, so the documented
contract in `docs/api.md` holds.

## Considered and rejected

- **An `idempotency_keys` collection.** Requires a new collection, a TTL sweep, and stored
  response snapshots — and it has a worse failure mode: after the TTL expires, a very stale
  queue entry double-writes anyway. The `_id` approach has no expiry.

## Consequences

- No new collection, no TTL sweep, no response-snapshot storage, and no window after which
  idempotency silently lapses.
- The client owns identifier generation, so the server must validate that the supplied `_id`
  is a well-formed UUID and must not let a client overwrite another user's document — the
  insert is always scoped by `userId`, and a duplicate `_id` belonging to a different user is
  a conflict, not a replay.
- If a future non-create endpoint needs true replay semantics (returning the original response
  body for a non-idempotent operation), that is when the collection earns its place. Noted so
  the decision is revisited deliberately rather than by default.
