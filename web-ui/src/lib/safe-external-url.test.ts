// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { safeExternalUrl } from './safe-external-url';

describe('safeExternalUrl', () => {
  it.each(['https://example.test/x', 'http://example.test', 'HTTPS://example.test'])(
    'returns the original string for %s',
    (value) => {
      expect(safeExternalUrl(value)).toBe(value);
    },
  );

  it('returns the trimmed original, not the normalised URL', () => {
    expect(safeExternalUrl('  https://Example.test  ')).toBe('https://Example.test');
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
