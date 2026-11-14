/**
 * HAP-1693: `infrastructure/config/templates/staging.json` said `trustProxy: 1` while Build01 staging runs with
 * `TRUST_PROXY` 2 (compose default, HAP-1091). The compose env wins at runtime, so the template only misled whoever
 * copied it. Both are loaded through the real config loader and must give the same `server.trustProxy`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { parse } from 'yaml';
import { ConfigurationLoader } from '../../../packages/common/src/config/config.loader';

const REPO = resolve(__dirname, '../../..');
const STAGING_TEMPLATE = join(REPO, 'infrastructure/config/templates/staging.json');
const STAGING_COMPOSE = join(REPO, 'deploy/build01-staging.compose.yml');

// Placeholder values for what the template leaves to the environment, so the loader validates; nothing connects.
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
  AWS_ACCESS_KEY_ID: 'unused',
  AWS_SECRET_ACCESS_KEY: 'unused',
  SSL_KEY_PATH: '/unused.key',
  SSL_CERT_PATH: '/unused.crt',
};

/** The api-server's `TRUST_PROXY` as compose passes it with `HAPPYCMDB_TRUST_PROXY` unset: `${VAR:-default}` resolved. */
function composeTrustProxyDefault(): string {
  const environment = parse(readFileSync(STAGING_COMPOSE, 'utf8')).services['api-server'].environment;
  const raw: string | undefined = Array.isArray(environment)
    ? environment.find((e: string) => e.startsWith('TRUST_PROXY='))?.slice('TRUST_PROXY='.length)
    : environment.TRUST_PROXY;
  if (raw === undefined) throw new Error('compose api-server has no TRUST_PROXY entry');
  return String(raw).replace(/\$\{HAPPYCMDB_TRUST_PROXY:-([^}]*)\}/, '$1');
}

let savedEnv: NodeJS.ProcessEnv;
let emptyDir: string;

beforeEach(() => {
  savedEnv = { ...process.env };
  // The loader reads `.env*` from cwd; run it from an empty directory, like the image's /app.
  emptyDir = mkdtempSync(join(tmpdir(), 'hap1693-'));
  jest.spyOn(process, 'cwd').mockReturnValue(emptyDir);
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(emptyDir, { recursive: true, force: true });
  process.env = savedEnv;
});

function loadTrustProxy(configFile: string, trustProxyEnv?: string): unknown {
  delete process.env.TRUST_PROXY;
  Object.assign(process.env, REQUIRED_ENV, { NODE_ENV: 'production' });
  if (trustProxyEnv !== undefined) process.env.TRUST_PROXY = trustProxyEnv;
  return new ConfigurationLoader(configFile).load().server.trustProxy;
}

describe('HAP-1693: staging.json template trustProxy matches the Build01 staging compose default', () => {
  it('loads from the template (file value, no TRUST_PROXY env) to the same value compose delivers via env', () => {
    const fromCompose = loadTrustProxy(join(emptyDir, 'no-such-config.json'), composeTrustProxyDefault());
    const fromTemplate = loadTrustProxy(STAGING_TEMPLATE);
    expect(fromTemplate).toBe(fromCompose);
  });
});
