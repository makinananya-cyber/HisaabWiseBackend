import argon2 from 'argon2';

import type { Argon2Backend } from './hashing';

/**
 * The Node argon2id backend: the native addon, unchanged from what ADR-0004 specified and what the
 * measured 23 ms hash / 21 ms verify was taken against.
 *
 * This module is imported only by `src/server.ts`. Keeping it out of `hashing.ts` is what allows a
 * Worker bundle to exist at all — a static import of `argon2` anywhere in the reachable graph pulls
 * in a compiled `.node` binary that workerd cannot load and wrangler cannot bundle.
 *
 * `raw: false` is stated rather than left to the default, because the library's two `hash` overloads
 * differ only by that flag — `raw: true` returns a `Buffer` — and being explicit is what makes the
 * returned PHC string a type-level fact rather than an assumption.
 */
export const nodeArgon2: Argon2Backend = {
  hash: (secret, params) =>
    argon2.hash(secret, {
      type: argon2.argon2id,
      memoryCost: params.memoryKib,
      timeCost: params.timeCost,
      parallelism: params.parallelism,
      raw: false,
    }),
  verify: (hash, secret) => argon2.verify(hash, secret),
};
