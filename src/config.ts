import { z } from 'zod';

/**
 * The one place environment variables are read, and the only runtime boundary for configuration.
 *
 * Validated once at startup rather than per request, so a misconfigured deployment **fails to
 * boot** instead of accepting traffic and failing later. That is the substance of Technical Spec
 * §3's "fail fast if absent": a server with no database URI should not be answering health checks
 * at all.
 *
 * Types are inferred from the schema, never hand-written alongside it (Rule 1).
 */

/** Log levels pino understands, narrowed so a typo in the environment is caught here. */
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 8080 rather than wrangler's old 8787: it is what container platforms expect by default, and
  // 8787 collided with an unrelated local service during setup.
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  LOG_LEVEL: logLevel.default('info'),

  // ── Database ────────────────────────────────────────────────────────────────────────────────
  // Required. The URI must name the database in its path — a bare `mongodb+srv://host/` silently
  // resolves to a database called `test`, so the trailing name is checked rather than trusted.
  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .refine((uri) => /^mongodb(\+srv)?:\/\/[^/]+\/[^/?]+/.test(uri), {
      message:
        'MONGODB_URI must name a database in its path, e.g. mongodb+srv://host/hisaabwise_dev — ' +
        'without one the driver silently uses a database called "test"',
    }),
  // A long-lived process wants one shared, bounded pool. This is the Node counterpart of
  // invariant 9: the invariant's mechanism (`maxPoolSize: 1`) existed because Workers isolates
  // are ephemeral and each would open its own connection. A single warm pool serves the same end
  // — a hard ceiling on connections to Atlas — without a connection per request.
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  // ── Secrets that land with their slice ──────────────────────────────────────────────────────
  // Optional here, required by `requireSecret` at the point of use, so slice 0 runs without
  // credentials it has no code for while a missing one still fails loudly the moment it matters.
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('60d'),

  // argon2id, tunable without a code change. Measured at 23 ms hash / 21 ms verify on Node at
  // these values. Raise the time cost if that ever needs to grow; never lower the memory cost.
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),

  FX_PROVIDER_API_KEY: z.string().optional(),
  FX_BASE_CURRENCY: z.string().length(3).default('USD'),

  APNS_KEY_P8: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),

  SENTRY_DSN: z.string().optional(),

  // Marketing site only — the iOS client needs no CORS.
  CORS_ORIGINS: z.string().default(''),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

export type Config = z.infer<typeof configSchema>;

/** Raised when the environment cannot produce a usable configuration. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

/**
 * Validate an environment into a `Config`.
 *
 * Takes the environment as an argument rather than reading `process.env` directly so tests can
 * build a configuration without mutating global state.
 *
 * @throws {ConfigurationError} listing every problem at once — one boot, one complete answer,
 * rather than a developer fixing variables one restart at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new ConfigurationError(
    `Invalid environment configuration:\n${problems}\n\n` +
      'Copy .env.example to .env and fill in what you need. Never point a local MONGODB_URI at ' +
      'the production database (workspace Rule 4).',
  );
}

/**
 * The secrets that are optional in the schema because no code needs them yet. Each becomes
 * required through `requireSecret` in the slice that uses it.
 */
type OptionalSecret =
  | 'JWT_ACCESS_SECRET'
  | 'FX_PROVIDER_API_KEY'
  | 'APNS_KEY_P8'
  | 'APNS_KEY_ID'
  | 'APNS_TEAM_ID'
  | 'APNS_BUNDLE_ID'
  | 'SENTRY_DSN';

/**
 * Read a secret that a feature genuinely requires, failing with a message that names it.
 *
 * The alternative — marking every secret required in the schema — would mean slice 0 could not
 * start without an APNs key it has no code for.
 */
export function requireSecret(config: Config, key: OptionalSecret): string {
  const value = config[key];
  if (value === undefined || value === '') {
    throw new ConfigurationError(
      `${key} is required for this feature but is not set. Add it to .env locally, or to the ` +
        'environment secrets for a deployed environment.',
    );
  }
  return value;
}
