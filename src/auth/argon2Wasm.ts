import { argon2id, argon2Verify } from 'hash-wasm';

import type { Argon2Backend } from './hashing';

/**
 * The Cloudflare Workers argon2id backend: `hash-wasm`, a WebAssembly build that needs no native
 * addon and no Node bindings.
 *
 * **Do not rename this file to anything containing `.wasm.`** — it was `argon2.wasm.ts` first, and
 * wrangler's default module rules map `**~/*.wasm` to `CompiledWasm`, so the *TypeScript source*
 * was uploaded as a WebAssembly module. The deploy failed inside Cloudflare's API with
 * `expected magic word 00 61 73 6d, found 69 6d 70 6f` — `69 6d 70 6f` being the ASCII for the
 * `impo` of this file's own `import` statement. It bundles locally either way; only the upload
 * rejects it, so `wrangler deploy --dry-run` does not catch this.
 *
 * **This is the part of the Workers port that carries real risk**, and it is worth being precise
 * about why rather than discovering it in production.
 *
 * argon2id is deliberately expensive — that is the entire point of it — and Workers bills CPU time
 * per invocation against a hard ceiling. On the **Workers Free plan the ceiling is 10 ms of CPU**,
 * and these parameters measure 23 ms on Node with a *native* implementation; WebAssembly in an
 * isolate is slower still. Login, registration and recovery will therefore exceed the free-plan
 * limit every single time and be killed mid-request. The paid plan raises the ceiling to 30 s of
 * CPU, which clears it comfortably — so **this backend requires Workers Paid, not by preference but
 * arithmetically.**
 *
 * The memory cost is the other bound worth naming: at the default 19456 KiB each concurrent hash
 * claims ~19 MB inside an isolate limited to 128 MB. That is fine for the handful of concurrent
 * logins this service sees, and it is the reason the memory cost must not be raised casually here
 * even though raising it would be sound advice on Node.
 *
 * The output is a standard PHC string, identical in form to the native addon's, so hashes written
 * by the Node deployment verify here and vice versa.
 */
export const wasmArgon2: Argon2Backend = {
  async hash(secret, params) {
    // 16 bytes, the size the reference implementation uses and what the native addon generates.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return argon2id({
      password: secret,
      salt,
      memorySize: params.memoryKib,
      iterations: params.timeCost,
      parallelism: params.parallelism,
      hashLength: 32,
      outputType: 'encoded',
    });
  },

  // `argon2Verify` reads the parameters back out of the stored PHC string, so a hash written under
  // one cost setting still verifies after the configuration is raised — the same property the
  // native addon has, and what makes ARGON2_TIME_COST safe to change without invalidating anyone.
  verify: (hash, secret) => argon2Verify({ password: secret, hash }),
};
