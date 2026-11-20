// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { sanitizeManifestUrl, sanitizeRegistryRowUrls } from '../safe-manifest-url';

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

describe('sanitizeRegistryRowUrls', () => {
  const row = {
    connector_type: 'acme',
    name: 'Acme',
    homepage: 'javascript:alert(1)',
    repository: ' https://Example.test/r ',
    downloads: 3,
    tags: ['a'],
  };

  it('returns a copy with both URLs sanitised and every other column untouched', () => {
    const before = structuredClone(row);
    const out = sanitizeRegistryRowUrls(row);

    expect(out).not.toBe(row);
    expect(out).toEqual({ ...before, homepage: '', repository: 'https://example.test/r' });
    expect(out.tags).toBe(row.tags);
    expect(row).toEqual(before);
  });

  it.each([
    ['https://user:pw@evil.test/', ''],
    ['https:\\\\evil.test', 'https://evil.test/'],
    ['', ''],
  ])('maps %j to %j in both fields', (value, expected) => {
    expect(sanitizeRegistryRowUrls({ homepage: value, repository: value })).toEqual({
      homepage: expected,
      repository: expected,
    });
  });

  it('keeps null as null and a missing key missing', () => {
    expect(sanitizeRegistryRowUrls({ homepage: null, repository: null })).toEqual({ homepage: null, repository: null });
    const out = sanitizeRegistryRowUrls({ name: 'x' });
    expect(out).toEqual({ name: 'x' });
    expect(out).not.toHaveProperty('homepage');
    expect(out).not.toHaveProperty('repository');
    expect(sanitizeRegistryRowUrls({ homepage: 'https://example.test', name: 'x' })).toEqual({
      homepage: 'https://example.test/',
      name: 'x',
    });
  });

  it('blanks a stored non-string value', () => {
    expect(sanitizeRegistryRowUrls({ homepage: 42, repository: { href: 'https://example.test' } })).toEqual({
      homepage: '',
      repository: '',
    });
  });
});
