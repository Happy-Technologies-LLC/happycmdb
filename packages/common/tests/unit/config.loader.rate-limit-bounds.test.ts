// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Every `rateLimit.endpoints.*` budget fails closed at config load: `max` is an integer >= 0 (0 = no limit / no
 * limiter) and `windowMs` an integer >= 1. A negative `max` would answer every request 429 and a `windowMs` of 0 or
 * less stops the limiter limiting, so neither may load. Exercised through the real ConfigurationLoader, from the
 * config file and from the environment (where an unparsable value reaches the schema as NaN).
 */

import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigurationLoader } from '../../src/config/config.loader';

// endpoint key -> env variable prefix
const ENDPOINTS = {
  rest: 'RATE_LIMIT_REST',
  graphql: 'RATE_LIMIT_GRAPHQL',
  health: 'RATE_LIMIT_HEALTH',
  auth: 'RATE_LIMIT_AUTH',
  authAccount: 'RATE_LIMIT_AUTH_ACCOUNT',
  authAccountGlobal: 'RATE_LIMIT_AUTH_ACCOUNT_GLOBAL',
  agentHeartbeat: 'RATE_LIMIT_AGENT_HEARTBEAT',
  discovery: 'RATE_LIMIT_DISCOVERY',
  admin: 'RATE_LIMIT_ADMIN',
} as const;
type Endpoint = keyof typeof ENDPOINTS;
const endpoints = Object.keys(ENDPOINTS) as Endpoint[];
const cases = endpoints.flatMap((endpoint) => [[endpoint, 'max'], [endpoint, 'windowMs']] as const);

let savedEnv: NodeJS.ProcessEnv;
let dir: string;

beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, {
    JWT_SECRET: randomBytes(32).toString('hex'),
    NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
    POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
    REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
  });
  for (const key of Object.keys(process.env)) if (key.startsWith('RATE_LIMIT_')) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'rate-limit-bounds-'));
  // Keep the real repo's .env* and config/test.json out of the load (the loader reads them relative to the cwd).
  jest.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
});

function loadFromFile(endpoint: Endpoint, field: 'max' | 'windowMs', value: unknown) {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ rateLimit: { endpoints: { [endpoint]: { [field]: value } } } }));
  return new ConfigurationLoader(path).load().rateLimit.endpoints;
}

function loadFromEnv(endpoint: Endpoint, field: 'max' | 'windowMs', value: string) {
  process.env[`${ENDPOINTS[endpoint]}_${field === 'max' ? 'MAX' : 'WINDOW_MS'}`] = value;
  return new ConfigurationLoader().load().rateLimit.endpoints;
}

describe('rateLimit.endpoints bounds', () => {
  it.each(cases)('%s.%s: a file value of -1 or 1.5 refuses the load', (endpoint, field) => {
    for (const value of [-1, 1.5]) {
      expect(() => loadFromFile(endpoint, field, value)).toThrow(`rateLimit.endpoints.${endpoint}.${field}`);
    }
  });

  it.each(endpoints)('%s.windowMs: 0 refuses the load', (endpoint) => {
    expect(() => loadFromFile(endpoint, 'windowMs', 0)).toThrow(`rateLimit.endpoints.${endpoint}.windowMs`);
    expect(() => loadFromEnv(endpoint, 'windowMs', '0')).toThrow(`rateLimit.endpoints.${endpoint}.windowMs`);
  });

  it.each(cases)('%s.%s: an env value of -1 or an unparsable one (NaN) refuses the load', (endpoint, field) => {
    for (const value of ['-1', 'not-a-number']) {
      expect(() => loadFromEnv(endpoint, field, value)).toThrow(`rateLimit.endpoints.${endpoint}.${field}`);
    }
  });

  it.each(endpoints)('%s: max 0 and 1, windowMs 1 and a large window still load', (endpoint) => {
    expect(loadFromFile(endpoint, 'max', 0)[endpoint].max).toBe(0);
    expect(loadFromFile(endpoint, 'max', 1)[endpoint].max).toBe(1);
    expect(loadFromFile(endpoint, 'windowMs', 1)[endpoint].windowMs).toBe(1);
    expect(loadFromEnv(endpoint, 'windowMs', '86400000')[endpoint].windowMs).toBe(86_400_000);
  });

  it('keeps the shipped defaults when nothing is configured', () => {
    const loaded = new ConfigurationLoader().load().rateLimit.endpoints;
    expect(loaded.agentHeartbeat).toEqual({ max: 600, windowMs: 3_600_000 });
    expect(loaded.health).toEqual({ max: 0, windowMs: 60_000 });
  });
});
