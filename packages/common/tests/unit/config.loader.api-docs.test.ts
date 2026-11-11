// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1881: `server.apiDocsEnabled` is strict-boolean in ConfigSchema. A hand-written config file with a
 * non-boolean value must leave /api-docs off (warning names the key only) instead of failing loadConfig();
 * the env var keeps its exact-`true` rule.
 */

import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigurationLoader } from '../../src/config/config.loader';
import { getLogger } from '../../src/logging/logger';

const ENV_KEYS = [
  'API_DOCS_ENABLED', 'JWT_SECRET', 'NEO4J_URI', 'NEO4J_USERNAME', 'NEO4J_PASSWORD',
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
  delete process.env['API_DOCS_ENABLED'];
  dir = mkdtempSync(join(tmpdir(), 'hap1881-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function loadWithFile(server: Record<string, unknown>) {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ server }));
  return new ConfigurationLoader(path).load();
}

describe('server.apiDocsEnabled from the config file', () => {
  it.each([
    ['string "true"', 'true'],
    ['string "false"', 'false'],
    ['number 1', 1],
    ['null', null],
  ])('leaves docs off and still loads when the value is %s', (_label, value) => {
    const warn = jest.spyOn(getLogger(), 'warn').mockImplementation(() => getLogger());

    const config = loadWithFile({ apiDocsEnabled: value });

    expect(config.server.apiDocsEnabled).toBe(false);
    const warnings = warn.mock.calls.map((call) => JSON.stringify(call));
    expect(warnings.some((w) => w.includes('server.apiDocsEnabled'))).toBe(true);
  });

  it('never logs the rejected value', () => {
    const warn = jest.spyOn(getLogger(), 'warn').mockImplementation(() => getLogger());

    loadWithFile({ apiDocsEnabled: 'canary-value' });

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('canary-value');
  });

  it('honours a JSON boolean true', () => {
    expect(loadWithFile({ apiDocsEnabled: true }).server.apiDocsEnabled).toBe(true);
  });

  it('is off when the key is absent', () => {
    expect(loadWithFile({}).server.apiDocsEnabled).toBe(false);
  });

  it('env API_DOCS_ENABLED=true overrides a bad file value; any other env value is off', () => {
    process.env['API_DOCS_ENABLED'] = 'true';
    expect(loadWithFile({ apiDocsEnabled: 'nope' }).server.apiDocsEnabled).toBe(true);
    process.env['API_DOCS_ENABLED'] = 'yes';
    expect(loadWithFile({ apiDocsEnabled: true }).server.apiDocsEnabled).toBe(false);
  });
});
