import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The one error envelope, and the codes that may appear in it.
 *
 * ```json
 * { "error": { "code": "EMAIL_TAKEN", "message": "That email already has an account" } }
 * ```
 *
 * **The `code` is the contract; the `message` is for a developer reading a log.** iOS ADR-0016
 * decided the client never displays the server's prose — English reaching an Arabic-reading user in
 * every failure state is the defect that prevents — so the client decodes the code and maps it to
 * localised copy. That makes the code a hard contract and the message free text, and it is worth
 * knowing which is which before editing either.
 */

/**
 * Every code this service can return.
 *
 * A closed set here, deliberately, even though the client's `ErrorCode` is open-ended: the client
 * must tolerate a code it has never heard of, and the server must not invent one by accident.
 */
export const ERROR_CODES = {
  // ── Generic ─────────────────────────────────────────────────────────────────────────────────
  NOT_FOUND: 'Route not found',
  INTERNAL: 'Internal server error',
  /** A body that failed zod validation. The offending fields go to the log, not the response. */
  VALIDATION_FAILED: 'The request body was not valid',
  RATE_LIMITED: 'Too many requests',

  // ── Session ─────────────────────────────────────────────────────────────────────────────────
  /**
   * No usable session. The client answers this by refreshing once and retrying (iOS ADR-0007), so
   * it must **only** be used for "this token is no good" — never for a field being wrong.
   */
  UNAUTHENTICATED: 'Authentication is required',
  /** A valid token whose bearer may not have this. Distinct from `UNAUTHENTICATED` on purpose. */
  FORBIDDEN: 'Not permitted',

  // ── Registration and sign-in ────────────────────────────────────────────────────────────────
  EMAIL_TAKEN: 'That email already has an account',
  /**
   * A wrong password, a wrong `currentPassword`, or an unknown email.
   *
   * **One code for all three**, which is the anti-enumeration property: a caller cannot tell an
   * unknown address from a wrong password, and ADR-0010 requires the timing to match as well as the
   * body. On a password *change* it must arrive as `422`, never `401` — see `httpStatusFor`.
   */
  INVALID_CREDENTIALS: 'Those credentials were not accepted',
  ACCOUNT_LOCKED: 'Too many failed attempts; try again later',
  ACCOUNT_PENDING_DELETION: 'This account is scheduled for deletion',
  UNDER_AGE: 'An account requires an age of 13 or over',
  TERMS_NOT_ACCEPTED: 'The terms must be accepted',

  // ── Recovery ────────────────────────────────────────────────────────────────────────────────
  /** One or both answers were wrong. It never says which — that is a hint to whoever is guessing. */
  SECURITY_ANSWERS_INVALID: 'The security answers were not accepted',
  RESET_TICKET_INVALID: 'That reset link is no longer valid',

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────
  MONTH_CLOSED: 'That month has been closed and can no longer be changed',
  ALREADY_RECORDED: 'That entry has already been recorded',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * The HTTP status each code travels on.
 *
 * **`INVALID_CREDENTIALS` is 422, not 401, and that is a constraint the client discovered by writing
 * a test for it.** On this client a `401` means "your token is no good", so it spends the refresh
 * token and retries; against a rotating token family, answering a mistyped `currentPassword` with a
 * `401` would refresh, find the family revoked, and sign the user out for a typo. A `422` is what the
 * client can read as "that field was wrong". Sign-in is unauthenticated and answers the same code —
 * which is fine, because the refresh machinery is deliberately kept out of that path.
 */
const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  INTERNAL: 500,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 422,
  ACCOUNT_LOCKED: 429,
  ACCOUNT_PENDING_DELETION: 403,
  UNDER_AGE: 422,
  TERMS_NOT_ACCEPTED: 422,
  SECURITY_ANSWERS_INVALID: 422,
  RESET_TICKET_INVALID: 422,
  MONTH_CLOSED: 409,
  ALREADY_RECORDED: 409,
};

export const httpStatusFor = (code: ErrorCode): ContentfulStatusCode => STATUS[code];

/** The envelope, as an object. One shape, built in one place. */
export const errorBody = (code: ErrorCode, message?: string): { error: { code: ErrorCode; message: string } } => ({
  error: { code, message: message ?? ERROR_CODES[code] },
});

/**
 * A failure a route means to return, thrown from wherever it is discovered.
 *
 * Thrown rather than returned so that a repository or a domain function can refuse without every
 * caller in between having to thread a result type through. `src/index.ts`'s `onError` turns it into
 * the envelope; anything else that reaches there is a `500`, which is the correct distinction — an
 * `ApiError` is a *decision*, an unexpected throw is a *bug*.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ErrorCode,
    /**
     * The **developer's** message: what shows in a stack trace and in the log line.
     *
     * A domain function that refuses something should say why here — "cannot add INR to AED" is worth
     * far more to whoever is debugging than "Internal server error", and a pure function throwing
     * outside a request has no log line to fall back on. It does not reach the client for an
     * `INTERNAL`; see `body`.
     */
    message?: string,
    /** Structured detail for the log only. Never serialised — it may name fields or internals. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_CODES[code]);
  }

  get status(): ContentfulStatusCode {
    return httpStatusFor(this.code);
  }

  /**
   * The response body.
   *
   * **An `INTERNAL` always answers with the canonical text, never `this.message`.** The message on an
   * internal failure is written for a developer and names internals — a collection, a currency pair, a
   * field path — and a `500` is exactly the response an attacker probes for. Every other code's message
   * is client-facing by construction, so it passes through.
   */
  get body(): { error: { code: ErrorCode; message: string } } {
    return errorBody(this.code, this.code === 'INTERNAL' ? ERROR_CODES.INTERNAL : this.message);
  }
}
