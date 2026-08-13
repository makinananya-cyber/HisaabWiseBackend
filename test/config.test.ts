import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig, requireSecret } from '../src/config';

const minimal = { MONGODB_URI: 'mongodb://127.0.0.1:27017/hisaabwise_dev' } as const;

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig({ ...minimal });

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      LOG_LEVEL: 'info',
      MONGODB_MAX_POOL_SIZE: 10,
      ARGON2_MEMORY_KIB: 19456,
      ARGON2_TIME_COST: 2,
      FX_BASE_CURRENCY: 'USD',
    });
  });

  it('coerces numeric variables, which arrive as strings', () => {
    const config = loadConfig({ ...minimal, PORT: '3000', MONGODB_MAX_POOL_SIZE: '4' });

    expect(config.PORT).toBe(3000);
    expect(config.MONGODB_MAX_POOL_SIZE).toBe(4);
  });

  it('fails fast when MONGODB_URI is absent, naming it', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig({})).toThrow(/MONGODB_URI/);
  });

  // The connection string handed over for this project ended at `mongodb.net/` with no database
  // name, which the driver silently resolves to a database called `test`. Silently writing user
  // data to the wrong database is worth failing a boot over.
  it('rejects a URI that names no database', () => {
    expect(() => loadConfig({ MONGODB_URI: 'mongodb+srv://user:pw@cluster.mongodb.net/' })).toThrow(
      /must name a database/,
    );
  });

  it('accepts a URI that names one, with or without query parameters', () => {
    expect(
      loadConfig({ MONGODB_URI: 'mongodb+srv://user:pw@cluster.mongodb.net/hisaabwise_dev' })
        .MONGODB_URI,
    ).toContain('hisaabwise_dev');
    expect(
      loadConfig({
        MONGODB_URI: 'mongodb+srv://user:pw@cluster.mongodb.net/hisaabwise_dev?retryWrites=true',
      }).MONGODB_URI,
    ).toContain('hisaabwise_dev');
  });

  it('reports every problem at once, so one boot gives one complete answer', () => {
    let message = '';
    try {
      loadConfig({ MONGODB_URI: 'not-a-uri', PORT: '-1', LOG_LEVEL: 'chatty' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/MONGODB_URI/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/LOG_LEVEL/);
  });

  it('rejects a JWT secret too short to be worth having', () => {
    expect(() => loadConfig({ ...minimal, JWT_ACCESS_SECRET: 'short' })).toThrow(
      ConfigurationError,
    );
  });

  it('does not put the connection string in the error message', () => {
    // The URI carries a password. A validation error that echoes the value would put it in logs.
    let message = '';
    try {
      loadConfig({ MONGODB_URI: 'mongodb+srv://user:hunter2@cluster.mongodb.net/' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).not.toContain('hunter2');
  });
});

describe('requireSecret', () => {
  it('returns a secret that is present', () => {
    const config = loadConfig({ ...minimal, JWT_ACCESS_SECRET: 'x'.repeat(32) });

    expect(requireSecret(config, 'JWT_ACCESS_SECRET')).toHaveLength(32);
  });

  it('throws with the variable named when a feature needs one that is unset', () => {
    const config = loadConfig({ ...minimal });

    expect(() => requireSecret(config, 'JWT_ACCESS_SECRET')).toThrow(/JWT_ACCESS_SECRET/);
  });
});

describe('TLS verification', () => {
  const withTls = (nodeEnv: string, flag: string) =>
    loadConfig({ ...minimal, NODE_ENV: nodeEnv, NODE_TLS_REJECT_UNAUTHORIZED: flag });

  it('refuses to boot in production with certificate verification disabled', () => {
    expect(() => withTls('production', '0')).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('allows it in development, since that is the developer’s own machine', () => {
    expect(() => withTls('development', '0')).not.toThrow();
  });

  it('is untroubled when the flag is absent or enabled', () => {
    expect(() => loadConfig({ ...minimal, NODE_ENV: 'production' })).not.toThrow();
    expect(() => withTls('production', '1')).not.toThrow();
  });
});
