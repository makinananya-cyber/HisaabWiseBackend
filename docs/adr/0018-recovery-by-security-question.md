# ADR-0018 — Account recovery is by security question and date of birth; there is no email reset

**Status:** accepted, 13 August 2026
**Amends:** [ADR-0004](0004-identity-and-credentials.md) (recovery mechanism), [ADR-0010](0010-auth-throttling.md) (a second, separate lockout)
**Supersedes:** the `verify-email` and `resend-verification` routes in Technical Spec §5; drops the `email_verifications` collection — **nine collections, not ten**
**Relates to:** invariant 4, invariant 5

## Context

Registration collects an email address, a phone number and a date of birth, and **verifies none of
them**. Phone verification was dropped (O2: collect, do not verify, do not rely on it) and email
verification with it, because nothing in the product depends on either being real and adding an email
provider to the critical path of slice 2 would have gated identity on domain verification and
deliverability.

That decision has a consequence that has to be faced rather than discovered: **the two security answers
become the entire account-recovery mechanism.** There is no second route. And the mechanism has to work
against a stored *hash*, because invariant 5 forbids keeping raw answers — which rules out the fuzzy
matching that would make a human-typed answer forgiving.

## Decision

**Recovery is a three-step flow, mirroring the in-session password change the client already implements.**

1. `POST /v1/auth/forgot-password/questions` — email in, **the account's two question ids** out.
2. `POST /v1/auth/forgot-password/verify` — email + both answers + **date of birth** → a single-use,
   short-lived reset ticket.
3. `POST /v1/auth/reset-password` — ticket + new password. Revokes every refresh-token family and
   increments `securityEpoch`.

**Normalise, then hash, then compare exactly.** Every tolerance the system offers is baked into
`src/domain/securityAnswers.ts` and applied identically at registration and at verification: accents
stripped, case folded, punctuation and apostrophes dropped, filler words removed, a plural `s`
singularised, and the remaining words **sorted** so order does not matter. Levenshtein distance is
deliberately gone — it cannot be computed against a hash — so `Jaipur` against a stored `Jodhpur` fails.

**Date of birth is required as a third factor.** It is already collected for the 13+ gate, it costs the
user one field on a screen that does not exist yet, and it meaningfully raises the bar on a mechanism
that is now load-bearing.

**`password_resets` survives with a new job**: single-use server-issued tickets, not emailed tokens.
Ten-minute TTL, claimed by a conditional update so "single use" is enforced by the write rather than by
a read the caller could race.

**`emailVerified` stays in the contract, always `true`.** The client threads it through `Session`,
`AccountScreen`, `AccountView` and the unverified banner — roughly fifty references plus
`me-unverified.json` and `account-unverified.json`. Removing the concept would be an iOS change and a
fixture-corpus change for no functional gain, so the field stays, the server sets it at registration,
the banner never fires, and verification remains addable later without a client change.

## The two risks, accepted with open eyes

**1 — There is no path back for a user who misremembers an answer.** Comparison is exact on the
normalised form, and with email reset gone there is no second route. Worse, because `DELETE /v1/me`
requires a session, a locked-out user cannot exercise their PDPL erasure right either — so this is a
**compliance gap, not only a support one**. `BACKEND_PLAN.md` §9.2 carries it as an open item: it needs
an owned manual process before launch, and that is a business decision rather than a code one.

**2 — Two low-entropy answers are the whole of takeover defence** on an app holding salary and spending
data, and the unverified email is not even a channel for warning the real owner. Mitigations, all built
and none costing UX:

- **A separate lockout for recovery** (`recoveryFailedCount`, `recoveryLockedUntil`), distinct from
  login's. Sharing login's would let a stranger's failed password guesses lock the real owner out of the
  mechanism they would use to recover — and, in the other direction, recovery attempts must not lock
  sign-in.
- **Both answers required**, and no indication of which failed. The design reddens the specific field,
  which it can only do because it compares raw strings in the browser (defect D4); telling somebody which
  of two guesses landed halves the work of guessing the other.
- **Identical body and timing for an address with no account**, on both step 1 and step 2. Step 1 is the
  subtle one: it would be a *better* enumeration oracle than login, because it needs no password guess
  and spends no lockout budget. So an unknown address gets two plausible question ids, derived
  deterministically from the address — random ids would differ between two requests for the same address,
  which is itself the tell.
- **Single-use tickets**, and issuing a new one invalidates any the user already had.
- **A logged alert at `warn` on every successful reset.** This is the only route back into an account, so
  it is the event an operator should be able to find.

## Consequences

- Slice 2 no longer needs a mail provider, which takes domain verification and deliverability off the
  critical path entirely. `BACKEND_PLAN.md` §7 moves it off the lead-time table.
- The client has one screen to build that the corpus has no fixture for. This backend defines the shape
  and the iOS slice follows it — the reverse of the usual direction in this project (ADR-0017), and noted
  in `endpoints.ts` so it is not mistaken for a gap.
- The normaliser is now a **migration-sensitive** function. A change to it invalidates every stored
  answer hash. `test/domain/securityAnswers.test.ts` pins the canonical form literally so that a diff
  touching it is visible as such rather than reading like a refactor.
