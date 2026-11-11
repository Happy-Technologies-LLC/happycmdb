/**
 * HAP-1872: the Docker api-server image has no `.env` and no `config/` directory, so a JWT_* entry on a compose
 * `api-server` service is only worth shipping if the REAL `ConfigurationLoader` (the code the api-server runs at boot)
 * reads it. `JWT_EXPIRES_IN: 7d` sat in three compose files while the loader reads only `JWT_ACCESS_TOKEN_EXPIRES_IN` and
 * `JWT_REFRESH_TOKEN_EXPIRES_IN`: it looked like a 7-day access token and did nothing.
 * For every JWT_* key of every tracked compose file's `api-server` environment, setting that key alone (against a
 * baseline with none) must change the loaded `auth.jwt` config; a key the loader ignores fails.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { parse } from 'yaml';
import { ConfigurationLoader } from '../../../packages/common/src/config/config.loader';

const REPO = resolve(__dirname, '../../..');

/** The environment keys of a compose `api-server` service (map or `KEY=value` list form). */
function apiServerKeys(file: string): string[] | undefined {
  const environment = parse(readFileSync(join(REPO, file), 'utf8'))?.services?.['api-server']?.environment;
  if (environment === undefined) return undefined;
  return Array.isArray(environment) ? environment.map((e: string) => e.split('=')[0]) : Object.keys(environment);
}

/** Every tracked compose file (git pathspec glob) whose `api-server` has an `environment:` block, with its JWT_* keys. */
const JWT_KEYS: Array<[string, string]> = execFileSync(
  'git', ['ls-files', '-z', '--', ':(glob)**/*compose*.yml', ':(glob)**/*compose*.yaml'], { cwd: REPO, encoding: 'utf8' },
).split('\0').filter(Boolean).flatMap((file) =>
  (apiServerKeys(file) ?? []).filter((key) => key.startsWith('JWT_')).map((key): [string, string] => [file, key]));

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

let cwdSpy: jest.SpyInstance;
let emptyDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // The loader reads `.env*` from cwd; run from an empty directory, like the image's /app.
  emptyDir = mkdtempSync(join(tmpdir(), 'hap1872-'));
  cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(emptyDir);
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(emptyDir, { recursive: true, force: true });
  process.env = savedEnv;
});

/** `auth.jwt` as the api-server would load it with `extra` on top of the placeholder environment and no other JWT_*. */
function loadJwt(extra: Record<string, string>): unknown {
  for (const k of Object.keys(process.env)) if (k.startsWith('JWT_')) delete process.env[k];
  Object.assign(process.env, REQUIRED_ENV, { NODE_ENV: 'production' }, extra);
  return new ConfigurationLoader(join(emptyDir, 'no-such-config.json')).load().auth.jwt;
}

describe('HAP-1872: compose api-server JWT_* entries are read by the config loader', () => {
  it('finds compose files with JWT_* entries to check', () => {
    expect(JWT_KEYS.length).toBeGreaterThan(0);
  });

  it.each(JWT_KEYS)('%s: %s changes the loaded auth.jwt config', (_file, key) => {
    const baseline = loadJwt({});
    // Long enough for JWT_SECRET's 32-character minimum; any string is valid for the others.
    const withKey = loadJwt({ [key]: `hap1872-${randomBytes(20).toString('hex')}` });
    expect(withKey).not.toEqual(baseline);
  });
});
