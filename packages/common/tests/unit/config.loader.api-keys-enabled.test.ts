// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth.apiKeys.enabled` is a security switch: API_KEYS_ENABLED=false must be able to turn API-key
 * authentication off. The environment wins when it is `true` or `false` (trimmed, case-insensitive);
 * any other value falls through to the config file boolean, else the default `true`.
 */

import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigurationLoader } from '../../src/config/config.loader';

const ENV_KEYS = [
  'API_KEYS_ENABLED', 'API_KEY_HEADER_NAME', 'JWT_SECRET', 'NEO4J_URI', 'NEO4J_USERNAME', 'NEO4J_PASSWORD',
  'POSTGRES_HOST', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
  'REDIS_HOST', 'KAFKA_CLIENT_ID', 'KAFKA_GROUP_ID',
];
const savedEnv: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
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
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function load(envValue: string | undefined, apiKeys?: Record<string, unknown>) {
  if (envValue !== undefined) process.env['API_KEYS_ENABLED'] = envValue;
  if (apiKeys === undefined) return new ConfigurationLoader().load().auth.apiKeys;
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ auth: { apiKeys } }));
  return new ConfigurationLoader(path).load().auth.apiKeys;
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

  it.each([undefined, '', '1', 'yes', '0'])('falls through to the file value when the env is %j', (value) => {
    expect(load(value, { enabled: false }).enabled).toBe(false);
    expect(load(value, { enabled: true }).enabled).toBe(true);
  });

  it.each([undefined, '', '1', 'yes', '0'])('defaults to true with no file when the env is %j', (value) => {
    expect(load(value).enabled).toBe(true);
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
