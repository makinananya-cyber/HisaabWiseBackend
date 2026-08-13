import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import argon2 from 'argon2';

import type { Config } from '../config';

/**
 * Two hashes, for two different jobs, and the difference matters (ADR-0004).
 *
 * **argon2id for passwords and security answers.** These are low-entropy human secrets, so the whole
 * defence is making each guess expensive. OWASP minimum parameters: m = 19 MiB, t = 2, p = 1,
 * env-tunable — and if cost has to rise, **raise the time cost, never lower the memory cost**, because
 * memory hardness is what defeats GPU cracking.
 *
 * **Plain SHA-256 for refresh tokens and reset tickets.** These are 32 bytes of CSPRNG output. There is
 * no low-entropy secret for a slow hash to protect, and argon2 on the refresh path would burn 20 ms of
 * CPU on every app foreground for nothing.
 *
 * Getting this backwards in either direction is a real failure: argon2 on refresh is a self-inflicted
 * denial of service, and SHA-256 on a password is a rainbow table away from being no protection at all.
 */

/**
 * argon2id parameters from configuration, so cost is tunable without a code change.
 *
 * `raw: false` is stated rather than left to the default, because the library's two `hash` overloads
 * differ only by that flag — `raw: true` returns a `Buffer` — and being explicit is what makes the
 * returned PHC string a type-level fact rather than an assumption.
 */
const options = (config: Config): argon2.HashOptions & { raw: false } => ({
  type: argon2.argon2id,
  memoryCost: config.ARGON2_MEMORY_KIB,
  timeCost: config.ARGON2_TIME_COST,
  parallelism: 1,
  raw: false,
});

/**
 * Hash a password or a security answer.
 *
 * The salt is generated per hash by the library and encoded into the returned PHC string, so there is
 * no salt column and no chance of reusing one.
 */
export const hashSecret = async (config: Config, secret: string): Promise<string> =>
  argon2.hash(secret, options(config));

/**
 * Verify a password or a security answer against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed stored hash: a corrupt record must read as "does
 * not match" and be logged, not as a 500 that tells the caller their guess was interesting.
 */
export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

/**
 * A **dummy verify against a real hash**, for the unknown-email path.
 *
 * ADR-0010 requires that an account which does not exist be indistinguishable from a wrong password in
 * body *and timing*. Returning early for an unknown email would leak existence through a response that
 * arrives 20 ms sooner — a difference an attacker can measure over a few hundred requests. So the
 * unknown-email path verifies the presented password against this hash and discards the result, paying
 * the same argon2 cost.
 *
 * The hash is of a value nothing can present, generated once per process: a fixed literal in the source
 * would be a published hash, which is harmless here but pointless.
 */
let decoyHash: string | undefined;

export async function equaliseTiming(config: Config, presented: string): Promise<void> {
  decoyHash ??= await hashSecret(config, randomBytes(32).toString('hex'));
  await verifySecret(decoyHash, presented);
}

/** A 32-byte CSPRNG token, base64url, for a refresh token or a reset ticket. */
export const mintOpaqueToken = (): string => randomBytes(32).toString('base64url');

/** The stored form of an opaque token. Never the token itself — a database dump must not be a key ring. */
export const hashOpaqueToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * A refresh token is looked up *by* its hash, so the database index does the comparison and this is
 * belt and braces. It earns its place on the reset-ticket path, where a ticket is checked against a
 * candidate row.
 */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself be the leak it exists to prevent.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
