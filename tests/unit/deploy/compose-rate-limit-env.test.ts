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
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { parse } from 'yaml';
import { ConfigurationLoader } from '../../../packages/common/src/config/config.loader';

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
  RATE_LIMIT_BYPASS_SECRET: ['bypassSecret', 'hap1842-bypass-secret', 'hap1842-bypass-secret'],
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
