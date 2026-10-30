// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1210 S2a: client errors are logged as label, class and status only; never the error object.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { AxiosError, AxiosHeaders, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { logClientError } from './logger';

// Built at runtime from neutral parts so no fixture looks like a real value.
const MARK = ['h1210', 's2a', 'mark'].join('-');
const TOK = ['h1210', 's2a', 'tok'].join('-');
const LABEL = 'Failed to create credential:';

function axiosError(code: string, status?: number): AxiosError {
  const config = {
    url: `/credentials/${MARK}`,
    headers: new AxiosHeaders({ Authorization: `Bearer ${TOK}` }),
    data: JSON.stringify({ note: MARK }),
  } as InternalAxiosRequestConfig;
  const response = status === undefined ? undefined
    : { status, statusText: MARK, data: { message: MARK }, headers: {}, config } as AxiosResponse;
  return new AxiosError(`failed ${MARK}`, code, config, { responseText: MARK }, response);
}

let spy: MockInstance;
beforeEach(() => {
  spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  const seen = inspect(spy.mock.calls, { depth: null, maxArrayLength: null, maxStringLength: null });
  spy.mockRestore();
  expect(seen).not.toContain(MARK);
  expect(seen).not.toContain(TOK);
});

function logged(error: unknown): unknown[] {
  logClientError(LABEL, error);
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0];
}

describe('logClientError (HAP-1210 S2a, T1)', () => {
  it('emits only the label, the error class and the HTTP status for a token-bearing AxiosError', () => {
    expect(logged(axiosError('ERR_BAD_RESPONSE', 500))).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'AxiosError', status: 500 }]);
  });

  it.each(['ERR_NETWORK', 'ECONNABORTED'])('adds the allow-listed code %s only when there is no status', (code) => {
    expect(logged(axiosError(code))).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'AxiosError', code }]);
  });

  it('reports a cancelled request by class and allow-listed code', () => {
    expect(logged(new CanceledError(MARK))).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'CanceledError', code: 'ERR_CANCELED' }]);
  });

  it.each([['ERR_BAD_REQUEST'], [MARK]])('drops the non-allow-listed code %s', (code) => {
    expect(logged(axiosError(code))).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'AxiosError' }]);
  });

  it('emits the code it checked, even when a getter changes its value after the first read', () => {
    const error = axiosError('ERR_NETWORK');
    let reads = 0;
    Object.defineProperty(error, 'code', { get: () => (++reads === 1 ? 'ERR_NETWORK' : MARK) });
    expect(logged(error)).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'AxiosError', code: 'ERR_NETWORK' }]);
  });

  it('does not admit a code inherited from Object.prototype', () => {
    Object.defineProperty(Object.prototype, MARK, { value: true, configurable: true });
    try {
      expect(logged(axiosError(MARK))).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'AxiosError' }]);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[MARK];
    }
  });

  it.each<[string, unknown, string]>([
    ['a plain Error', new Error(MARK), 'Error'],
    ['an Error renamed to the marker', Object.assign(new Error(MARK), { name: MARK }), 'NonError'],
    ['a thrown string', MARK, 'NonError'],
    ['an error-like object', { name: 'Error', message: MARK, code: MARK, response: { status: `${MARK}` } }, 'NonError'],
  ])('reads nothing else from %s', (_, error, errorClass) => {
    expect(logged(error)).toEqual([`[ERROR] ${LABEL}`, { errorClass }]);
  });
});

// The S2a call sites: every token-bearing raw-error log in these files is migrated (S2b widens this to the tree).
const MIGRATED = [
  'components/analytics/ExportButton.tsx',
  'components/credentials/CredentialSetForm.tsx',
  'components/credentials/CredentialSetList.tsx',
  'components/discovery/DiscoveryJobTrigger.tsx',
  'components/settings/ApiKeysManager.tsx',
  'components/settings/DatabaseSettings.tsx',
  'contexts/AuthContext.tsx',
  'hooks/useCredentials.ts',
  'hooks/useDiscoveryJobs.ts',
  'pages/Credentials.tsx',
  'pages/BusinessServices.tsx',
];

describe('migrated call sites (HAP-1210 S2a, T2)', () => {
  const sources = MIGRATED.map((file) => [file, readFileSync(join(__dirname, '..', file), 'utf8')] as const);

  it('never hand an error object to the console', () => {
    const hits = sources.flatMap(([file, text]) =>
      text.split('\n').flatMap((line, i) => (/\bconsole\s*[.[]/.test(line) ? [`${file}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it('log through logClientError with a fixed string-literal label', () => {
    for (const [file, text] of sources) {
      const calls = text.match(/\blogClientError\(/g) ?? [];
      const literal = text.match(/\blogClientError\(\s*(['"])[^'"`$\\]*\1\s*,/g) ?? [];
      expect({ file, calls: calls.length }).toEqual({ file, calls: literal.length });
      expect({ file, used: calls.length > 0 }).toEqual({ file, used: true });
    }
  });
});
