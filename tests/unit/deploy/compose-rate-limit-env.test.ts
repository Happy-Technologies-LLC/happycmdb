/**
 * HAP-1842: the Docker api-server image has no `.env` (`.dockerignore`: `**\/.env*`) and no `config/` directory,
 * so the only way an operator can tune the rate limiter is an `environment:` entry on the compose `api-server`
 * service. This resolves each compose file's `RATE_LIMIT_*` entries the way Compose interpolates them (against a
 * shell environment) and feeds the result to the REAL `ConfigurationLoader`, the code the api-server runs at boot:
 *  - with nothing set in the shell, the resolved config equals the config with no `RATE_LIMIT_*` at all (every
 *    compose default equals the `config.schema.ts` default);
 *  - a value set in the shell for each knob reaches the loaded `rateLimit` config (an `environment:` entry that is
 *    missing, misspelled or hard-coded fails for that knob);
 *  - every leaf of the schema's `rateLimit` config has such a knob, so a new schema field cannot ship unforwarded.
 * The forwarded RATE_LIMIT_BYPASS_SECRET skips every limiter, login included: the shipped `.env.example`, sourced the
 * way `./deploy.sh` does and resolved through each compose file, must not let a known or short secret through the real
 * `RateLimitMiddleware.limit('auth', ...)` that guards POST /auth/login.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { inspect } from 'util';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { parse } from 'yaml';
import { ConfigurationLoader } from '../../../packages/common/src/config/config.loader';
import { getLogger } from '../../../packages/common/src/logging/logger';
import { RateLimitMiddleware } from '../../../packages/api-server/src/middleware/rate-limit.middleware';

const REPO = resolve(__dirname, '../../..');
const COMPOSE_FILES = ['infrastructure/docker/docker-compose.yml', 'deploy/build01-staging.compose.yml'];

// Placeholder config so the loader validates; nothing connects.
const REQUIRED_ENV: Record<string, string> = {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1',
  NEO4J_USERNAME: 'unused',
  NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_DB: 'unused',
  POSTGRES_USER: 'unused',
  POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1',
  KAFKA_CLIENT_ID: 'unused',
  KAFKA_GROUP_ID: 'unused',
};

/** Compose `${VAR}`, `${VAR:-default}`, `${VAR-default}` interpolation (the forms the RATE_LIMIT_* entries use). */
function interpolate(value: string, shell: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?:(:?-)([^}]*))?\}/g, (_m, name: string, op?: string, dflt?: string) => {
    const v = shell[name];
    if (op === ':-') return v === undefined || v === '' ? dflt ?? '' : v;
    if (op === '-') return v === undefined ? dflt ?? '' : v;
    return v ?? '';
  });
}

/** The `RATE_LIMIT_*` entries of the compose `api-server` service, after interpolation against `shell`. */
function apiServerRateLimitEnv(file: string, shell: Record<string, string>): Record<string, string> {
  const compose = parse(readFileSync(join(REPO, file), 'utf8'));
  const environment = compose?.services?.['api-server']?.environment;
  const out: Record<string, string> = {};
  const entries: Array<[string, string]> = Array.isArray(environment)
    ? environment.map((e: string): [string, string] => {
        const i = e.indexOf('=');
        return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)];
      })
    : Object.entries(environment ?? {}).map(([k, v]): [string, string] => [k, String(v ?? '')]);
  for (const [key, raw] of entries) {
    if (key.startsWith('RATE_LIMIT_')) out[key] = interpolate(raw, shell);
  }
  return out;
}

let cwdSpy: jest.SpyInstance;
let emptyDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // The loader reads `.env*` from cwd; run from an empty directory, like the image's /app.
  emptyDir = mkdtempSync(join(tmpdir(), 'hap1842-'));
  cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(emptyDir);
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(emptyDir, { recursive: true, force: true });
  process.env = savedEnv;
});

/** Load config as the api-server would, with exactly `rateLimitEnv` as the process's RATE_LIMIT_* variables. */
function loadRateLimit(rateLimitEnv: Record<string, string>): any {
  for (const k of Object.keys(process.env)) if (k.startsWith('RATE_LIMIT_')) delete process.env[k];
  Object.assign(process.env, REQUIRED_ENV, { NODE_ENV: 'production' }, rateLimitEnv);
  return new ConfigurationLoader(join(emptyDir, 'no-such-config.json')).load().rateLimit;
}

// env var -> [config path, value set in the shell, value the loaded config must hold]
const KNOBS: Record<string, [string, string, unknown]> = {
  RATE_LIMIT_ENABLED: ['enabled', 'false', false],
  RATE_LIMIT_BYPASS_HEADER: ['bypassHeader', 'X-Hap1842-Bypass', 'X-Hap1842-Bypass'],
  RATE_LIMIT_BYPASS_SECRET: ['bypassSecret', 'hap1842-bypass-secret-0123456789abcdef', 'hap1842-bypass-secret-0123456789abcdef'],
  RATE_LIMIT_TIER_STANDARD_MULTIPLIER: ['tierMultipliers.standard', '7', 7],
  RATE_LIMIT_TIER_PREMIUM_MULTIPLIER: ['tierMultipliers.premium', '11', 11],
  RATE_LIMIT_TIER_ENTERPRISE_MULTIPLIER: ['tierMultipliers.enterprise', '23', 23],
  RATE_LIMIT_REST_MAX: ['endpoints.rest.max', '1001', 1001],
  RATE_LIMIT_REST_WINDOW_MS: ['endpoints.rest.windowMs', '3600001', 3600001],
  RATE_LIMIT_GRAPHQL_MAX: ['endpoints.graphql.max', '501', 501],
  RATE_LIMIT_GRAPHQL_WINDOW_MS: ['endpoints.graphql.windowMs', '3600002', 3600002],
  RATE_LIMIT_HEALTH_MAX: ['endpoints.health.max', '9', 9],
  RATE_LIMIT_HEALTH_WINDOW_MS: ['endpoints.health.windowMs', '60001', 60001],
  RATE_LIMIT_AUTH_MAX: ['endpoints.auth.max', '3', 3],
  RATE_LIMIT_AUTH_WINDOW_MS: ['endpoints.auth.windowMs', '3600003', 3600003],
  RATE_LIMIT_AUTH_ACCOUNT_MAX: ['endpoints.authAccount.max', '4', 4],
  RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MS: ['endpoints.authAccount.windowMs', '900001', 900001],
  RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_MAX: ['endpoints.authAccountGlobal.max', '0', 0],
  RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_WINDOW_MS: ['endpoints.authAccountGlobal.windowMs', '900002', 900002],
  RATE_LIMIT_DISCOVERY_MAX: ['endpoints.discovery.max', '101', 101],
  RATE_LIMIT_DISCOVERY_WINDOW_MS: ['endpoints.discovery.windowMs', '3600004', 3600004],
  RATE_LIMIT_ADMIN_MAX: ['endpoints.admin.max', '201', 201],
  RATE_LIMIT_ADMIN_WINDOW_MS: ['endpoints.admin.windowMs', '3600005', 3600005],
  RATE_LIMIT_MONITORING_ENABLED: ['monitoring.enabled', 'false', false],
  RATE_LIMIT_LOG_HITS: ['monitoring.logRateLimitHits', 'false', false],
};

function leafPaths(obj: any, prefix = ''): string[] {
  return Object.entries(obj ?? {}).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? leafPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

describe('HAP-1842: compose api-server RATE_LIMIT_* reach the running config', () => {
  it('every leaf of the schema rateLimit config has a tested knob', () => {
    const baseline = loadRateLimit({});
    // bypassSecret is optional with no schema default, so it is absent from the defaults.
    const leaves = new Set([...leafPaths(baseline), 'bypassSecret']);
    const covered = new Set(Object.values(KNOBS).map(([path]) => path));
    expect([...leaves].filter((p) => !covered.has(p))).toEqual([]);
    expect([...covered].filter((p) => !leaves.has(p))).toEqual([]);
  });

  describe.each(COMPOSE_FILES)('%s', (file) => {
    it('with nothing set in the shell, the forwarded defaults equal the schema defaults', () => {
      const forwarded = apiServerRateLimitEnv(file, {});
      expect(loadRateLimit(forwarded)).toEqual(loadRateLimit({}));
    });

    it.each(Object.entries(KNOBS))('%s set in the shell reaches the loaded config', (envName, [path, value, expected]) => {
      const forwarded = apiServerRateLimitEnv(file, { [envName]: value });
      const loaded = loadRateLimit(forwarded);
      expect(getPath(loaded, path)).toBe(expected);
      // and only that knob moved
      const rest = loadRateLimit({});
      for (const p of leafPaths(rest)) {
        if (p !== path) expect(getPath(loaded, p)).toBe(getPath(rest, p));
      }
    });
  });
});

/** The environment `./deploy.sh` runs Compose with: `file` sourced under `set -a` (deploy.sh: `set -a; source .env`). */
function shellFromEnvFile(file: string): Record<string, string> {
  const out = execFileSync('bash', ['-c', 'set -a; . "$1"; set +a; env -0', 'bash', file], {
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf8',
  });
  return Object.fromEntries(out.split('\0').filter(Boolean).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
}

/** Sorted sets as the sliding-window limiter uses them: the Redis store, not the code under test. */
function memoryRedis() {
  const sets = new Map<string, number[]>();
  const set = (key: string) => sets.get(key) ?? sets.set(key, []).get(key)!;
  return {
    pipeline() {
      const ops: Array<() => unknown> = [];
      return {
        zremrangebyscore: (key: string, _min: string, max: string) => { ops.push(() => sets.set(key, set(key).filter((s) => s > Number(max)))); },
        zcard: (key: string) => { ops.push(() => set(key).length); },
        zadd: (key: string, score: string) => { ops.push(() => set(key).push(Number(score))); },
        expire: () => { ops.push(() => 1); },
        exec: async () => ops.map((op) => [null, op()]),
      };
    },
  };
}

/** Loads config from `shell` through `file`'s api-server block; returns it with the loader's bypass WARN calls. */
function loadThroughCompose(file: string, shell: Record<string, string>): { rateLimit: any; bypassWarns: unknown[][] } {
  const warn = jest.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  try {
    const rateLimit = loadRateLimit(apiServerRateLimitEnv(file, shell));
    return { rateLimit, bypassWarns: warn.mock.calls.filter(([message]) => /bypass/i.test(String(message))) };
  } finally {
    warn.mockRestore();
  }
}

/**
 * authAccount.max + 1 logins for one account from one client, each sending `header: value`, through the login
 * route's limiter (`AuthController`: `limit('auth', { account: req => req.body?.username, failClosed: true })`).
 */
async function loginAttempts(rateLimit: any, header: string, value: string) {
  const limiter = new RateLimitMiddleware(memoryRedis() as never, rateLimit);
  let reached = 0;
  const app = express();
  app.post('/api/v1/auth/login', express.json(),
    limiter.limit('auth', { account: (req) => req.body?.username, failClosed: true }),
    (_req, res) => { reached++; res.status(401).json({ error: 'Invalid credentials' }); });
  const statuses: number[] = [];
  const limits: Array<string | undefined> = [];
  for (let i = 0; i <= rateLimit.endpoints.authAccount.max; i++) {
    const res = await request(app).post('/api/v1/auth/login').set(header, value).send({ username: 'admin', password: 'guess' });
    statuses.push(res.status);
    limits.push(res.headers['x-ratelimit-limit']);
  }
  return { statuses, limits, reached };
}

const ENV_EXAMPLE = join(REPO, '.env.example');
const SHIPPED_PLACEHOLDERS = ['your-internal-service-secret-change-this', 'your-internal-service-secret'];

describe.each(COMPOSE_FILES)('HAP-1842: .env.example through %s cannot bypass the login limiter', (file) => {
  let timerSpy: jest.SpyInstance;
  beforeEach(() => {
    // RATE_LIMIT_MONITORING_ENABLED/LOG_HITS are on in .env.example; the limiter's metrics timer would hold Jest open.
    timerSpy = jest.spyOn(global, 'setInterval').mockReturnValue(0 as never);
  });
  afterEach(() => timerSpy.mockRestore());

  const limited = (rateLimit: any) => ({
    statuses: [...Array(rateLimit.endpoints.authAccount.max).fill(401), 429],
    limits: Array(rateLimit.endpoints.authAccount.max + 1).fill(String(rateLimit.endpoints.auth.max)),
    reached: rateLimit.endpoints.authAccount.max,
  });

  it('the shipped .env.example: a shipped placeholder header is limited like any client, with no bypass WARN', async () => {
    const shell = shellFromEnvFile(ENV_EXAMPLE);
    const { rateLimit, bypassWarns } = loadThroughCompose(file, shell);
    expect(bypassWarns).toEqual([]);
    for (const placeholder of SHIPPED_PLACEHOLDERS) {
      expect(await loginAttempts(rateLimit, shell['RATE_LIMIT_BYPASS_HEADER']!, placeholder)).toEqual(limited(rateLimit));
    }
  });

  const short = randomBytes(32).toString('hex').slice(0, 31);
  it.each([...SHIPPED_PLACEHOLDERS.map((p): [string, string] => [p, p]), ['a 31-character random value', short]])(
    '.env.example with RATE_LIMIT_BYPASS_SECRET = %s: bypass refused with one WARN that omits the value',
    async (_label, secret) => {
      const shell = { ...shellFromEnvFile(ENV_EXAMPLE), RATE_LIMIT_BYPASS_SECRET: secret };
      const { rateLimit, bypassWarns } = loadThroughCompose(file, shell);
      expect(bypassWarns).toHaveLength(1);
      expect(inspect(bypassWarns)).not.toContain(secret);
      expect(await loginAttempts(rateLimit, shell['RATE_LIMIT_BYPASS_HEADER']!, secret)).toEqual(limited(rateLimit));
    });

  it('a 32-character random secret still bypasses, only with that exact value', async () => {
    const secret = randomBytes(24).toString('base64');
    expect(secret).toHaveLength(32);
    const shell = { ...shellFromEnvFile(ENV_EXAMPLE), RATE_LIMIT_BYPASS_SECRET: secret };
    const { rateLimit, bypassWarns } = loadThroughCompose(file, shell);
    expect(bypassWarns).toEqual([]);
    const header = shell['RATE_LIMIT_BYPASS_HEADER']!;
    const n = rateLimit.endpoints.authAccount.max + 1;
    expect(await loginAttempts(rateLimit, header, secret))
      .toEqual({ statuses: Array(n).fill(401), limits: Array(n).fill(undefined), reached: n });
    expect(await loginAttempts(rateLimit, header, `${secret}x`)).toEqual(limited(rateLimit));
  });
});
