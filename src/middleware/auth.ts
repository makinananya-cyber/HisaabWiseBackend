import type { MiddlewareHandler } from 'hono';

import { verifyAccessToken } from '../auth/tokens';
import { ApiError } from '../errors';
import { findById } from '../repositories/users';
import type { AppEnv } from '../types/hono';

/**
 * The authentication middleware, and the two checks that make a stateless token revocable.
 *
 * **1 — The signature and expiry**, by `verifyAccessToken`. Standard.
 *
 * **2 — The `sec` claim against the stored `securityEpoch`** (ADR-0005). This is the interesting one.
 * An access token cannot be revoked; it simply expires. Without this check, changing a password or
 * tapping "sign out other devices" would leave the other device working for up to fifteen minutes — the
 * user asked for something and nothing appeared to happen. With it, the epoch is bumped and every
 * outstanding token for that user fails on its next request.
 *
 * The cost is one document read per authenticated request, and it is not a cost the system was avoiding
 * anyway: almost every authenticated route needs the user document for the stored timezone and display
 * currency. Loading it here and putting it on the context means it is loaded **once** per request rather
 * than by each handler.
 *
 * **A soft-deleted account is refused here**, not per route. Deletion is a 30-day grace during which the
 * email stays reserved (ADR-0015), so the account exists and its tokens verify; what must not happen is
 * it continuing to be usable. `ACCOUNT_PENDING_DELETION` is a *flow* rather than a message — the client
 * offers to restore — which is why it is distinct from `UNAUTHENTICATED`.
 *
 * Every failure below `UNAUTHENTICATED` is one code, deliberately: the client's response to all of them
 * is identical (refresh once, then sign out), and naming which check failed tells a forger whether their
 * attempt was structurally plausible.
 */
export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : '';
    if (token === '') throw new ApiError('UNAUTHENTICATED');

    const claims = await verifyAccessToken(c.var.config, token);
    const user = await findById(claims.userId);

    // A token for a user who no longer exists — a purged account, or a token minted against a database
    // that has since been replaced. Indistinguishable from a forgery from here, and treated as one.
    if (user === null) throw new ApiError('UNAUTHENTICATED');

    if (claims.securityEpoch !== user.securityEpoch) throw new ApiError('UNAUTHENTICATED');

    if (user.deletedAt !== null) throw new ApiError('ACCOUNT_PENDING_DELETION');

    c.set('user', user);
    await next();
  };
}
