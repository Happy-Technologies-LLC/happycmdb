// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth.apiKeys.enabled` is a security switch: API_KEYS_ENABLED=false must be able to turn API-key
 * authentication off. The environment wins when it is `true` or `false` (trimmed, case-insensitive);
 * unset or blank falls through to the config file, else the default `true`. Any other env value, or a
 * file value that is not a boolean or the string "true"/"false", fails the load with an error that
 * names the key and not the value.
 */

import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigurationLoader } from '../../src/config/config.loader';

let savedEnv: NodeJS.ProcessEnv;
let dir: string;

beforeEach(() => {
  // Snapshot the whole environment: the loader's dotenv step may write any key into process.env.
  savedEnv = { ...process.env };
  // Placeholder config so validation passes; nothing connects. The secret is random per run.
  Object.assign(process.env, {
    JWT_SECRET: randomBytes(32).toString('hex'),
    NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
    POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
    REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
  });
  delete process.env['API_KEYS_ENABLED'];
  delete process.env['API_KEY_HEADER_NAME'];
  dir = mkdtempSync(join(tmpdir(), 'api-keys-enabled-'));
  // The loader reads .env and config/<NODE_ENV>.json relative to the cwd; point it at the empty scratch dir.
  jest.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
});

function load(envValue: string | undefined, apiKeys?: Record<string, unknown>) {
  if (envValue !== undefined) process.env['API_KEYS_ENABLED'] = envValue;
  if (apiKeys === undefined) return new ConfigurationLoader().load().auth.apiKeys;
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ auth: { apiKeys } }));
  return new ConfigurationLoader(path).load().auth.apiKeys;
}

function loadError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the configuration load to throw');
}

describe('auth.apiKeys.enabled', () => {
  it('is turned off by API_KEYS_ENABLED=false with no config file', () => {
    expect(load('false').enabled).toBe(false);
  });

  it('lets the environment turn it off over a file that says true', () => {
    expect(load('false', { enabled: true }).enabled).toBe(false);
  });

  it('lets the environment turn it on over a file that says false', () => {
    expect(load('true', { enabled: false }).enabled).toBe(true);
  });

  it.each(['FALSE', ' false ', 'False\n'])('treats %j as false', (value) => {
    expect(load(value).enabled).toBe(false);
  });

  it.each(['TRUE', ' true '])('treats %j as true over a file false', (value) => {
    expect(load(value, { enabled: false }).enabled).toBe(true);
  });

  it.each([undefined, '', '   '])('falls through to the file value when the env is %j', (value) => {
    expect(load(value, { enabled: false }).enabled).toBe(false);
    expect(load(value, { enabled: true }).enabled).toBe(true);
  });

  it.each([undefined, '', '   '])('defaults to true with no file when the env is %j', (value) => {
    expect(load(value).enabled).toBe(true);
  });

  it.each(['0', 'no', 'off', 'disabled', 'False.'])('refuses to load when API_KEYS_ENABLED is %j', (value) => {
    const error = loadError(() => load(value));
    expect(error.message).toContain('API_KEYS_ENABLED');
    expect(error.message).toContain('"true" or "false"');
    expect(error.message).not.toContain(value);
  });

  it('refuses an unrecognized env value even when the file says false', () => {
    expect(loadError(() => load('off', { enabled: false })).message).toContain('API_KEYS_ENABLED');
  });

  it.each([0, 'off', {}, null])('refuses to load when auth.apiKeys.enabled in the file is %j', (value) => {
    const error = loadError(() => load(undefined, { enabled: value }));
    expect(error.message).toContain('auth.apiKeys.enabled');
    expect(error.message).toContain('"true" or "false"');
    expect(error.message).not.toContain(typeof value === 'string' ? value : JSON.stringify(value));
  });

  it('refuses a malformed file value even when a valid env value wins', () => {
    expect(loadError(() => load('false', { enabled: 'off' })).message).toContain('auth.apiKeys.enabled');
  });

  it('accepts the strings "false" and " TRUE " in the file and normalizes them to booleans', () => {
    expect(load(undefined, { enabled: 'false' }).enabled).toBe(false);
    expect(load(undefined, { enabled: ' TRUE ' }).enabled).toBe(true);
  });

  it('defaults to true when the file has apiKeys without enabled', () => {
    expect(load(undefined, { headerName: 'X-Other' }).enabled).toBe(true);
  });

  it('keeps the X-API-Key default header and the API_KEY_HEADER_NAME override', () => {
    expect(load(undefined).headerName).toBe('X-API-Key');
    process.env['API_KEY_HEADER_NAME'] = 'X-Custom-Key';
    expect(load('false').headerName).toBe('X-Custom-Key');
  });
});
