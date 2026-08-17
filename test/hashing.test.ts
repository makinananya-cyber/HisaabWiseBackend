import { beforeEach, describe, expect, it } from 'vitest';

import { nodeArgon2 } from '../src/auth/argon2.node';
import { wasmArgon2 } from '../src/auth/argon2.wasm';
import { hashSecret, setArgon2Backend, verifySecret } from '../src/auth/hashing';
import { loadConfig } from '../src/config';

/**
 * The argon2 seam, which exists because workerd cannot load a native addon (ADR-0016's table, read
 * in reverse). Two properties are worth holding down, and neither was covered before.
 *
 * The suite runs at the *configured* cost — 19456 KiB, t=2 — rather than a reduced one, because the
 * interoperability claim is only worth anything at the parameters actually deployed.
 */
const config = loadConfig({
  MONGODB_URI: 'mongodb://127.0.0.1:27017/hisaabwise_test_placeholder',
});

describe('the argon2 backend seam', () => {
  beforeEach(() => {
    setArgon2Backend(nodeArgon2);
  });

  it('round-trips a secret on the Node backend', async () => {
    const hash = await hashSecret(config, 'correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifySecret(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifySecret(hash, 'not the password')).resolves.toBe(false);
  });

  it('round-trips a secret on the WebAssembly backend', async () => {
    setArgon2Backend(wasmArgon2);
    const hash = await hashSecret(config, 'correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifySecret(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifySecret(hash, 'not the password')).resolves.toBe(false);
  });

  /**
   * The property that makes deploying to both runtimes safe: one user table, no re-hashing, and a
   * migration in either direction that nobody has to notice. If this ever fails, the two
   * deployments cannot share a database and that must not be discovered in production.
   */
  it('verifies a Node-written hash on the WebAssembly backend, and the reverse', async () => {
    const secret = 'a shared password';

    setArgon2Backend(nodeArgon2);
    const fromNode = await hashSecret(config, secret);

    setArgon2Backend(wasmArgon2);
    await expect(verifySecret(fromNode, secret)).resolves.toBe(true);
    await expect(verifySecret(fromNode, 'wrong')).resolves.toBe(false);
    const fromWasm = await hashSecret(config, secret);

    setArgon2Backend(nodeArgon2);
    await expect(verifySecret(fromWasm, secret)).resolves.toBe(true);
    await expect(verifySecret(fromWasm, 'wrong')).resolves.toBe(false);
  });

  it('encodes the configured cost parameters into the hash, on both backends', async () => {
    const costly = loadConfig({
      MONGODB_URI: 'mongodb://127.0.0.1:27017/hisaabwise_test_placeholder',
      ARGON2_MEMORY_KIB: '32768',
      ARGON2_TIME_COST: '3',
    });

    for (const backend of [nodeArgon2, wasmArgon2]) {
      setArgon2Backend(backend);
      const hash = await hashSecret(costly, 'secret');
      expect(hash).toContain('m=32768');
      expect(hash).toContain('t=3');
      expect(hash).toContain('p=1');
    }
  });

  /**
   * A corrupt stored hash must read as "does not match", not as a 500 that tells the caller their
   * guess was interesting. Asserted on both backends because the two libraries throw differently.
   */
  it('reads a malformed stored hash as a non-match rather than throwing', async () => {
    for (const backend of [nodeArgon2, wasmArgon2]) {
      setArgon2Backend(backend);
      await expect(verifySecret('not a phc string', 'secret')).resolves.toBe(false);
      await expect(verifySecret('', 'secret')).resolves.toBe(false);
    }
  });
});
