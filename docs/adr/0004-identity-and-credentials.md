# ADR-0004 — One atomic registration; argon2id parameters; security answers normalised then hashed

**Status:** accepted
**Supersedes:** Product Spec §4.3 (removes Levenshtein), Technical Spec §5 (resolves "one call or three"), §4 (`questionId`)
**Relates to:** workspace invariant 5, defect D4

## Context

Three credential decisions were open or self-contradictory.

**Registration shape.** Technical Spec §5 explicitly left it open: "steps collapsed to one
call or three". The choice determines whether half-built accounts exist in `users`, when
email verification fires, and whether abandoned registrations need a reaper job.

**Security answers are specified impossibly.** Product Spec §4.3 requires *both*
"Levenshtein ≤ 1 on words of 5+ characters" *and* "store a hash of the normalised key
words". You cannot compute an edit distance against a cryptographic hash — a one-character
difference produces an unrelated digest. One requirement had to go.

The prototype's matcher (found in the Account screen) is worse than the spec admits: it is a
**subset test**, not equality. Every stored keyword must appear *somewhere* in the typed
input, so stored `Biscuit` is satisfied by typing `Biscuit Jaipur London`. It also holds raw
answers in memory and passes them via `postMessage`.

Critically: **all four of §4.3's canonical test cases pass on normalisation alone.**
`St Mary's` → `st marys` either way; `Jaipur`/`Jodhpur` is edit distance 3, still ✗.

**Argon2 parameters were never chosen.** `DEVELOPMENT_PLAN.md` §8 flags "WASM argon2 cost
inside a CPU-limited isolate" as a risk but names no numbers.

**Security questions have no ids.** Technical Spec §4 specifies `{questionId, answerHash}`,
but the prototype's bank is 14 bare strings and the payload sends the full question text.
Text-as-key means one typo fix or the Arabic translation orphans every stored hash.

## Decision

**Registration is one atomic `POST /v1/auth/register`.** The client holds steps 1–2 in
memory and submits everything at the end; Submit and "Skip for now" are the same call,
differing only by `goalWasSkipped`. No partial users, no orphan reaper, no
"user exists but has no salary" state for every downstream route to defend against.
Email-uniqueness failure surfaces late — bounce to step 1 with a field error. **No
`check-email` endpoint**, deliberately: it is an account-enumeration oracle.

**Drop Levenshtein; normalise then hash.** The canonical normaliser:

```
NFD accent-strip → lowercase → strip apostrophes → punctuation to space → split
  → drop words of length ≤ 1 → drop the filler list → singularise trailing "s"
  → sort → join
```

then argon2id. Sorting makes it order-insensitive, matching the prototype's intent.
Comparison is **exact on the normalised form**. Invariant 5 holds — raw answers are never
stored and never returned.

**Argon2id at OWASP minimum: m = 19 MiB, t = 2, p = 1.** Measured, not assumed, in Phase 0
task 13. **If CPU is over budget, raise `t`, never lower `m`** — memory hardness is what
defeats GPU cracking. 19 MiB against a ~128 MB isolate leaves ample headroom, and login is
not a hot path. Security answers use the same parameters as passwords.

**Refresh, reset, and verification tokens get plain SHA-256**, not argon2: they are 32 bytes
of CSPRNG output, so there is no low-entropy secret for a slow hash to protect, and argon2
on the refresh path would burn CPU on every app foreground.

**Mint stable opaque question ids `sq01`…`sq14`.** They ship in `content/`; the English text
is localisable display content. `users.securityQuestions` stores only
`{questionId, answerHash}`.

## Consequences

- **Two prototype behaviours are deliberately lost:** Levenshtein typo tolerance, and the
  subset semantics. The subset behaviour was a weakness, not a feature. This is a
  user-visible strictness increase on a recovery flow, and it was accepted knowingly.
- Product Spec §4.3 must be amended — it currently mandates something impossible.
- The four canonical test cases still pass, so §4.3's acceptance criteria survive intact.
- The question bank can be reworded and translated without invalidating a single stored hash.
- One atomic register means the client holds a password in memory across three screens.
  Acceptable; it already does, between the field and the submit button.
