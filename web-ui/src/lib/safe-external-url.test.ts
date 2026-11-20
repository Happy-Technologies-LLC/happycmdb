// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { safeExternalUrl } from './safe-external-url';

// input -> the exact string handed to href and window.open
const ACCEPTED: Array<[string, string]> = [
  ['https://example.test/x', 'https://example.test/x'],
  ['http://example.test', 'http://example.test/'],
  ['HTTPS://example.test', 'https://example.test/'],
  ['  https://Example.test  ', 'https://example.test/'],
  // An `@` after the authority (path, query, fragment) is not userinfo.
  ['https://host/@path', 'https://host/@path'],
  ['https://host/?u=a@b', 'https://host/?u=a@b'],
  ['https://host/#a@b', 'https://host/#a@b'],
  // No `//` after the scheme: a browser would resolve the raw string against the page, so only the href is returned.
  ['https:/api/v1/x', 'https://api/v1/x'],
  ['https:evil.test', 'https://evil.test/'],
  ['HTTP:/x', 'http://x/'],
  ['https:\\evil.test', 'https://evil.test/'],
  ['https:\\\\evil.test', 'https://evil.test/'],
];

describe('safeExternalUrl', () => {
  it.each(ACCEPTED)('returns the validated URL for %j', (value, expected) => {
    expect(safeExternalUrl(value)).toBe(expected);
  });

  it.each(ACCEPTED)('returns a string that re-resolves to itself on an https and an http page for %j', (value) => {
    const result = safeExternalUrl(value);
    expect(result).not.toBeNull();
    expect(new URL(result as string, 'https://cmdb.example/').href).toBe(result);
    expect(new URL(result as string, 'http://cmdb.example/').href).toBe(result);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'file:///etc/passwd',
    'mailto:a@example.test',
    'blob:https://example.test/x',
    'blob:null/x',
    '//example.test',
    '/relative',
    'example.test',
    'https://exa\tmple.test',
    '',
    '   ',
  ])('rejects %j', (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });

  it.each([undefined, null, 42, {}, ['https://example.test']])('rejects non-string %j', (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });
});

// Userinfo is rejected, not stripped: `https://cmdb.example@evil.test/` would read like the CMDB host on hover.
describe('safeExternalUrl userinfo', () => {
  it.each([
    'https://user:pw@host/',
    'https://cmdb.example@evil.test/',
    'https://user@host/',
    'https://:pw@host/',
    'https://%75ser@host/',
    'https:\\\\user:pw@host',
    'HTTP://u:p@host',
  ])('rejects the URL with userinfo %j', (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });
});
