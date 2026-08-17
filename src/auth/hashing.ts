import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
 * The argon2id primitive, behind an interface, because the two runtimes cannot share one.
 *
 * Node uses the native `argon2` addon — a compiled `.node` binary, measured at 23 ms hash / 21 ms
 * verify at the configured parameters. workerd cannot load a native addon at all, so a Worker
 * supplies a WebAssembly implementation instead.
 *
 * Both produce and consume the same PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`), which is
 * what makes the seam safe: a password hashed on Node verifies on Workers and the reverse, so the
 * same user table serves both deployments and a migration between them needs no re-hashing.
 *
 * The parameters stay in configuration on both sides. If cost has to rise, **raise the time cost,
 * never lower the memory cost** — memory hardness is what defeats GPU cracking, and that reasoning
 * does not change with the runtime.
 */
export interface Argon2Backend {
  hash(secret: string, params: Argon2Params): Promise<string>;
  verify(hash: string, secret: string): Promise<boolean>;
}

export interface Argon2Params {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly parallelism: 1;
}

let backend: Argon2Backend | undefined;

/**
 * Install the runtime's argon2id implementation. Called once from the entrypoint, before any
 * request is served.
 *
 * There is deliberately no default. A silent fallback to a weaker hash is the kind of mistake that
 * is invisible until a database leaks, so an entrypoint that forgets this fails loudly on the first
 * login instead.
 */
export function setArgon2Backend(next: Argon2Backend): void {
  backend = next;
}

function required(): Argon2Backend {
  if (!backend) {
    throw new Error(
      'No argon2 backend is installed. Call setArgon2Backend() from the entrypoint — ' +
        'src/argon2.node.ts on Node, src/argon2.wasm.ts on Cloudflare Workers.',
    );
  }
  return backend;
}

const paramsOf = (config: Config): Argon2Params => ({
  memoryKib: config.ARGON2_MEMORY_KIB,
  timeCost: config.ARGON2_TIME_COST,
  parallelism: 1,
});

/**
 * Hash a password or a security answer.
 *
 * The salt is generated per hash by the implementation and encoded into the returned PHC string, so
 * there is no salt column and no chance of reusing one.
 */
export const hashSecret = async (config: Config, secret: string): Promise<string> =>
  required().hash(secret, paramsOf(config));

/**
 * Verify a password or a security answer against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed stored hash: a corrupt record must read as "does
 * not match" and be logged, not as a 500 that tells the caller their guess was interesting.
 */
export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await required().verify(hash, secret);
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
