import { argon2id } from '@noble/hashes/argon2.js';

import type { Argon2Backend, Argon2Params } from './hashing';

/**
 * The Cloudflare Workers argon2id backend: `@noble/hashes`, a **pure-JavaScript** implementation.
 *
 * **Why not a WebAssembly build.** The obvious choice was `hash-wasm`, and it was tried first. It
 * cannot run here: Cloudflare Workers refuse `WebAssembly.compile()`/`instantiate()` on bytes at
 * request time — `CompileError: Wasm code generation disallowed by embedder` — and `hash-wasm`
 * embeds its module as base64 and compiles it lazily on the first hash, inside the request. The
 * compile threw, `hash-wasm` left its internal load-lock held, and the next call awaited a lock that
 * would never release — so login, registration and recovery *hung* until the runtime killed the
 * request. workerd only permits WASM that a static module import compiled at startup, which the
 * inlined-base64 shape cannot provide. A pure-JS primitive sidesteps the whole rule.
 *
 * **The cost this trades for correctness.** Pure-JS argon2id at the configured 19456 KiB / t=2
 * measures ~450 ms of CPU in an isolate, against ~23 ms for the native addon on Node. Workers bills
 * CPU per invocation: the **Free plan's 10 ms ceiling kills every hash**, so this backend requires
 * **Workers Paid** (30 s ceiling) — not by preference but arithmetically. The memory cost is the
 * other bound: at 19456 KiB each concurrent hash claims ~19 MB inside a 128 MB isolate, which is why
 * the memory cost must not be raised casually here even though raising it is sound advice on Node.
 *
 * **Interoperability is exact, not approximate.** noble computes the same argon2id digest as the
 * native addon for the same password, salt and parameters — byte-for-byte — so a hash written by the
 * Node deployment verifies here and the reverse. The only wrinkle is cosmetic: the native library
 * emits its PHC parameters in `m,p,t` order while everything else uses `m,t,p`, so `parsePhc` reads
 * them by key rather than by position. One user table serves both runtimes with no re-hashing.
 */

const VERSION = 0x13; // argon2 v1.3 (19), the only version this service writes or accepts.
const SALT_BYTES = 16; // What the reference CLI and the native addon generate.
const HASH_BYTES = 32;

const encoder = new TextEncoder();

/** Standard base64 without padding — the alphabet a PHC string uses for its salt and digest. */
function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

interface ParsedPhc {
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly salt: Uint8Array;
  readonly digest: Uint8Array;
}

/**
 * Parse an argon2id PHC string — `$argon2id$v=19$m=…,t=…,p=…$salt$digest` — reading the parameters
 * by key so the native addon's `m,p,t` ordering and everyone else's `m,t,p` both work. Returns
 * `undefined` for anything that is not this exact shape, which `verify` reads as "does not match".
 */
function parsePhc(phc: string): ParsedPhc | undefined {
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', '<salt>', '<digest>']
  const [, algorithm, version, paramList, saltB64, digestB64] = phc.split('$');
  if (algorithm !== 'argon2id' || version !== 'v=19') return undefined;
  if (paramList === undefined || saltB64 === undefined || digestB64 === undefined) return undefined;

  const params = new Map<string, number>();
  for (const pair of paramList.split(',')) {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) params.set(key, Number(value));
  }
  const m = params.get('m');
  const t = params.get('t');
  const p = params.get('p');
  if (m === undefined || t === undefined || p === undefined) return undefined;
  if (!Number.isInteger(m) || !Number.isInteger(t) || !Number.isInteger(p)) return undefined;

  try {
    return { m, t, p, salt: fromB64(saltB64), digest: fromB64(digestB64) };
  } catch {
    return undefined;
  }
}

/** Length-safe, non-short-circuiting comparison, so a verify does not leak where two digests differ. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  // `?? 0` keeps the types honest under `noUncheckedIndexedAccess`; the length guard above means the
  // fallback is never actually taken.
  a.forEach((byte, i) => {
    diff |= byte ^ (b[i] ?? 0);
  });
  return diff === 0;
}

/**
 * A fresh CSPRNG salt per hash, encoded into the PHC string, so there is no salt column and no chance
 * of reusing one — the same property the native addon has.
 */
function hashSecret(secret: string, params: Argon2Params): string {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = argon2id(encoder.encode(secret), salt, {
    m: params.memoryKib,
    t: params.timeCost,
    p: params.parallelism,
    dkLen: HASH_BYTES,
    version: VERSION,
  });
  const meta = `m=${String(params.memoryKib)},t=${String(params.timeCost)},p=${String(params.parallelism)}`;
  return `$argon2id$v=19$${meta}$${toB64(salt)}$${toB64(digest)}`;
}

/**
 * The parameters are read back out of the stored PHC string, so a hash written under one cost setting
 * still verifies after the configuration is raised — the same property the native addon has, and what
 * makes ARGON2_TIME_COST safe to change without invalidating anyone.
 */
function verifySecret(hash: string, secret: string): boolean {
  const parsed = parsePhc(hash);
  if (!parsed) return false;
  const computed = argon2id(encoder.encode(secret), parsed.salt, {
    m: parsed.m,
    t: parsed.t,
    p: parsed.p,
    dkLen: parsed.digest.length,
    version: VERSION,
  });
  return constantTimeEqual(computed, parsed.digest);
}

// argon2id is CPU-bound and synchronous here; the backend interface is async because the native addon
// is, so these wrap the synchronous result to satisfy the one shape both runtimes share.
export const workersArgon2: Argon2Backend = {
  hash: (secret, params) => Promise.resolve(hashSecret(secret, params)),
  verify: (hash, secret) => Promise.resolve(verifySecret(hash, secret)),
};
