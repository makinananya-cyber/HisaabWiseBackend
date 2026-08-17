import type { AppLogger } from '../logging';

import type { Config } from '../config';
import type { User } from '../repositories/users';

/**
 * The Hono environment for this app.
 *
 * `Variables` replaces what `c.env` was on Workers. Configuration and the logger are injected by
 * middleware rather than reached for as module globals, so a test can build an app around a
 * different configuration without mutating `process.env`.
 *
 * `user` is set by `requireSession` and is therefore **only present on authenticated routes**. It is
 * typed as always-present because Hono has no way to express "set on some routes"; reading it from an
 * unauthenticated handler is a programming error that `sessionUser` below turns into a loud one rather
 * than an `undefined` flowing into a database query.
 */
export interface AppEnv {
  Variables: {
    config: Config;
    log: AppLogger;
    user: User;
    /**
     * The refresh-token family this session descends from, read off the access token's `fam` claim.
     *
     * Typed `| undefined` rather than as an optional key, because Hono's `Variables` cannot express "set on
     * some routes" and the honest type is the one that makes the caller check. Absent for a token minted
     * before the claim existed; the one route that reads it treats absence as "revoke everything", which is
     * the safe reading.
     */
    familyId: string | undefined;
  };
}
