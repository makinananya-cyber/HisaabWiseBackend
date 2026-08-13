import { jwtVerify, SignJWT } from 'jose';

import { requireSecret, type Config } from '../config';
import { ApiError } from '../errors';

/**
 * The access token: short-lived, stateless, and carrying exactly two claims the system acts on.
 *
 * **`sub`** is the user id. **`sec`** is the user's `securityEpoch` at the moment the token was minted
 * (ADR-0005), and it is the revocation mechanism for a token that cannot be revoked. Without it, a
 * password change would leave the old device working for up to fifteen minutes; with it, the auth
 * middleware compares the claim against the stored epoch and refuses immediately.
 *
 * The client reads `exp` and `sec` off the token itself rather than from sibling fields (iOS
 * `AccessToken`), so the response carries the token and nothing describing it. That removes the failure
 * mode where a server changes its token lifetime and forgets the field beside it.
 *
 * **No session collection.** The access token is stateless and `securityEpoch` is what invalidates it;
 * only the *refresh* token has a row, because rotation needs somewhere to record the chain.
 */

/** The claims this service mints and verifies. */
export interface AccessClaims {
  readonly userId: string;
  readonly securityEpoch: number;
  /**
   * The refresh-token **family** this session descends from (`fam`).
   *
   * Here so that "revoke every *other* session" is answerable from the access token alone. Product Spec §3.7
   * revokes every other session on a password change, and the requesting device must survive — otherwise
   * changing your password signs you out, which reads as a failure. The client sends no family identifier
   * (its `PasswordChange` body carries only the three fields the user typed), so the alternative was a header
   * it does not send and a fallback that revoked everything including the caller.
   *
   * Optional, because a token minted before this claim existed must keep working until it expires — and
   * because it is a *convenience* for one route rather than a security boundary: revocation is still bounded
   * by `familyId` in the database, and `securityEpoch` is still what invalidates a token.
   */
  readonly familyId?: string;
}

const ISSUER = 'hisaabwise';
const AUDIENCE = 'hisaabwise-app';

const secretKey = (config: Config): Uint8Array =>
  new TextEncoder().encode(requireSecret(config, 'JWT_ACCESS_SECRET'));

/**
 * Mint an access token.
 *
 * HS256 rather than an asymmetric algorithm: there is one issuer and one verifier, both this process,
 * so a public key would be ceremony with no second party to hand it to. If a second service ever needs
 * to verify these, that is the moment to move to RS256 — not before.
 */
export async function mintAccessToken(config: Config, claims: AccessClaims): Promise<string> {
  return new SignJWT({
    sec: claims.securityEpoch,
    ...(claims.familyId === undefined ? {} : { fam: claims.familyId }),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .sign(secretKey(config));
}

/**
 * Verify an access token and read its claims.
 *
 * @throws {ApiError} `UNAUTHENTICATED` for anything wrong with the token — a bad signature, an expired
 * token, the wrong issuer, a missing claim. **One code for all of them**, because the distinctions are
 * only useful to somebody probing: the client's response to every one of them is the same (refresh
 * once, then sign out), and naming which check failed tells an attacker whether their forgery was
 * structurally plausible.
 */
export async function verifyAccessToken(config: Config, token: string): Promise<AccessClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secretKey(config), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch {
    throw new ApiError('UNAUTHENTICATED');
  }

  const { sub, sec, fam } = payload;
  if (typeof sub !== 'string' || sub === '' || typeof sec !== 'number') {
    throw new ApiError('UNAUTHENTICATED');
  }

  return {
    userId: sub,
    securityEpoch: sec,
    ...(typeof fam === 'string' ? { familyId: fam } : {}),
  };
}

/**
 * The refresh token's lifetime, as a `Date`.
 *
 * Parsed from the same duration string the config carries (`60d`) rather than a second number in a
 * second unit, so the two cannot drift. `jose` parses the access TTL itself; there is no equivalent for
 * an opaque token, so this does it.
 *
 * @throws {ApiError} `INTERNAL` for an unparseable duration — a misconfiguration, discovered on the
 * first refresh rather than silently defaulting to something plausible.
 */
export function refreshTokenExpiry(config: Config, from: Date): Date {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(config.REFRESH_TOKEN_TTL.trim());
  if (match === null) {
    throw new ApiError(
      'INTERNAL',
      undefined,
      { REFRESH_TOKEN_TTL: config.REFRESH_TOKEN_TTL, expected: 'a duration like 60d, 24h, 30m or 90s' },
    );
  }

  const seconds = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(from.getTime() + Number(match[1]) * seconds * 1_000);
}
