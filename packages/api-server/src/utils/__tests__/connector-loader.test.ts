// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'fs';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { ConnectorLoader, sanitizeManifestUrl } from '../connector-loader';

jest.mock('fs');
jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn(() => ({})) }));
jest.mock('@cmdb/common', () => ({ logger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));

it('does not log a connector path or a provider error containing credentials', async () => {
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  (fs.readdirSync as jest.Mock).mockReturnValue([{
    name: 'client_secret=DO_NOT_LEAK', isDirectory: () => true,
  }]);
  (fs.readFileSync as jest.Mock).mockImplementation(() => {
    throw new Error('provider credential client_secret=DO_NOT_LEAK');
  });

  await new ConnectorLoader('/path/client_secret=DO_NOT_LEAK').loadAllConnectors();
  for (const method of ['info', 'warn', 'error'] as const) {
    expect(JSON.stringify((logger[method] as jest.Mock).mock.calls)).not.toContain('DO_NOT_LEAK');
  }
  expect(logger.error).toHaveBeenCalledWith('Failed to load connector');
});

// input -> the exact string stored in connector_registry_cache and installed_connectors.metadata
const ACCEPTED: Array<[string, string]> = [
  ['https://example.test/x', 'https://example.test/x'],
  ['http://example.test', 'http://example.test/'],
  ['HTTPS://example.test', 'https://example.test/'],
  ['  https://Example.test  ', 'https://example.test/'],
  ['https://host/@path', 'https://host/@path'],
  ['https://host/?u=a@b', 'https://host/?u=a@b'],
  ['https://host/#a@b', 'https://host/#a@b'],
  // No `//` after the scheme: the stored value must be the validated href, not the raw string.
  ['https:/api/v1/x', 'https://api/v1/x'],
  ['https:\\\\evil.test', 'https://evil.test/'],
];

describe('sanitizeManifestUrl', () => {
  it.each(ACCEPTED)('returns the normalised href for %j', (value, expected) => {
    expect(sanitizeManifestUrl(value)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    '//example.test',
    '/relative',
    'example.test',
    'https:',
    'https://user:pw@host/',
    'https://cmdb.example@evil.test/',
    'https://user@host/',
    'https://:pw@host/',
    'https://%75ser@host/',
    'https:\\\\user:pw@host',
    'HTTP://u:p@host',
    'https://exa\tmple.test',
    'https://example.test/\nx',
    'https://example.test/\u007f',
    '',
    '   ',
  ])('returns an empty string for %j', (value) => {
    expect(sanitizeManifestUrl(value)).toBe('');
  });

  it.each([undefined, null, 42, {}, ['https://example.test']])('returns an empty string for non-string %j', (value) => {
    expect(sanitizeManifestUrl(value)).toBe('');
  });
});

describe('connector registration', () => {
  const query = jest.fn();

  async function register(manifest: Record<string, unknown>): Promise<void> {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(manifest));
    (getPostgresClient as jest.Mock).mockReturnValue({ pool: { query } });
    await new ConnectorLoader('/connectors').loadConnector('acme');
  }

  // [registry cache INSERT params, installed_connectors INSERT params]
  function insertedParams(): [unknown[], unknown[]] {
    expect(query).toHaveBeenCalledTimes(2);
    return [query.mock.calls[0][1], query.mock.calls[1][1]];
  }

  const BASE = { id: 'acme', type: 'acme', name: 'Acme', version: '1.0.0', description: 'd', category: 'CONNECTOR' };
  // $9 homepage, $10 repository in the cache INSERT; $8 is the serialised manifest in the installed INSERT.
  const HOMEPAGE = 8;
  const REPOSITORY = 9;
  const MANIFEST = 7;

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it('stores empty URLs in both tables and warns once per field when the manifest URLs are unsafe', async () => {
    const manifest = { ...BASE, homepage: 'javascript:alert(1)', repository: 'https://u:p@host/r' };
    await register(manifest);
    const [cache, installed] = insertedParams();

    expect(cache[HOMEPAGE]).toBe('');
    expect(cache[REPOSITORY]).toBe('');
    const stored = JSON.parse(installed[MANIFEST] as string);
    expect(stored.homepage).toBe('');
    expect(stored.repository).toBe('');
    expect(manifest.homepage).toBe('javascript:alert(1)');
    expect(manifest.repository).toBe('https://u:p@host/r');

    expect((logger.warn as jest.Mock).mock.calls).toEqual([
      ['Connector manifest URL rejected', { field: 'homepage' }],
      ['Connector manifest URL rejected', { field: 'repository' }],
    ]);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toMatch(/javascript|host/);
  });

  it('stores the normalised hrefs in both tables and does not warn for a clean manifest', async () => {
    await register({ ...BASE, homepage: ' https://Example.test ', repository: 'https:/api/v1/x' });
    const [cache, installed] = insertedParams();

    expect(cache[HOMEPAGE]).toBe('https://example.test/');
    expect(cache[REPOSITORY]).toBe('https://api/v1/x');
    const stored = JSON.parse(installed[MANIFEST] as string);
    expect(stored.homepage).toBe('https://example.test/');
    expect(stored.repository).toBe('https://api/v1/x');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps absent URLs absent in the stored manifest and empty in the cache, without a warning', async () => {
    await register({ ...BASE });
    const [cache, installed] = insertedParams();

    expect(cache[HOMEPAGE]).toBe('');
    expect(cache[REPOSITORY]).toBe('');
    const stored = JSON.parse(installed[MANIFEST] as string);
    expect(stored).not.toHaveProperty('homepage');
    expect(stored).not.toHaveProperty('repository');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
