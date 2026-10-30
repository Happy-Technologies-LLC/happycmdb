// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1210 S2a: client errors are logged as label, class and status only; never the error object.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import AuthContext from '@/contexts/AuthContext';
import { apiClient } from '@/lib/api-client';
import { AgentList } from '@/components/discovery/AgentList';
import { CredentialForm } from '@/components/credentials/CredentialForm';
import { useWebSocket } from '@/hooks/useWebSocket';
import { PROTOCOL_DISPLAY_NAMES } from '@/lib/credential-display';
import { logClientError, logger } from './logger';

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

// Every console method and every logger level; the logger spies pass through to the console.
const CONSOLE = Object.keys(console).filter((m) => typeof console[m as keyof Console] === 'function') as 'log'[];
let spy: MockInstance;
let spies: MockInstance[];
beforeEach(() => {
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  spies.push(...(['info', 'debug', 'warn', 'error'] as const).map((m) => vi.spyOn(logger, m)));
  spy = vi.mocked(console.error);
});
afterEach(() => {
  const seen = inspect(spies.map((s) => s.mock.calls), { depth: null, maxArrayLength: null, maxStringLength: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('omits an allow-listed code when an HTTP status is present', () => {
    expect(logged(axiosError('ERR_NETWORK', 502))).toEqual([`[ERROR] ${LABEL}`, { errorClass: 'AxiosError', status: 502 }]);
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

  it.each<[string, unknown, object]>([
    ['a fetch network failure', new TypeError(`Failed to fetch ${MARK}`), { errorClass: 'TypeError' }],
    ['a thrown fetch Response', new Response(MARK, { status: 502, statusText: MARK, headers: { 'x-mark': MARK } }), { errorClass: 'NonError' }],
    ['an Apollo ServerError holding the fetch Response', Object.assign(new Error(MARK), { name: 'ServerError', response: new Response(MARK, { status: 401, statusText: MARK }), result: { message: MARK }, statusCode: 401 }), { errorClass: 'ServerError', status: 401 }],
  ])('logs only the class and status of %s (fetch guard)', (_, error, fields) => {
    expect(logged(error)).toEqual([`[ERROR] ${LABEL}`, fields]);
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
// logClientError sites per file, so that a deleted log line fails: S2a's 27 (in MIGRATED order), then S2b's.
const SITES = {
  ...Object.fromEntries(MIGRATED.map((file, i) => [file, [1, 1, 4, 1, 3, 1, 3, 1, 1, 8, 3][i]])),
  'components/common/ErrorBoundary.tsx': 1, 'components/credentials/CredentialForm.tsx': 1,
  'components/discovery/AgentDashboard.tsx': 1, 'components/discovery/AgentList.tsx': 1,
  'components/discovery/AgentSelector.tsx': 2, 'hooks/useWebSocket.ts': 3, 'services/graphql.ts': 1, 'utils/token.ts': 4,
};

describe('every non-test web-ui/src file (HAP-1210 S2b, T2)', () => {
  const sources = (readdirSync(join(__dirname, '..'), { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.|__tests__|^tests\/|^utils\/logger\.ts$/.test(file))
    .map((file) => [file, readFileSync(join(__dirname, '..', file), 'utf8')] as const);

  it('never names the console outside utils/logger.ts: no call, no console[m], no alias', () => {
    expect(sources.map(([file]) => file)).toContain('utils/token.ts');
    const hits = sources.flatMap(([file, text]) =>
      text.split('\n').flatMap((line, i) => (/\bconsole\b/.test(line) ? [`${file}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it('pass the logger one fixed string, never an error or object', () => {
    const hits = sources.filter(([, text]) =>
      (text.match(/\blogger\s*(?:\.\s*\w+|\[[^\]]*\])\s*\(/g) ?? []).length !==
      (text.match(/\blogger\s*(?:\.\s*\w+|\[[^\]]*\])\s*\(\s*(['"`])(?:(?!\1)[^\\]|\\.)*\1\s*\)/g) ?? []).length);
    expect(hits.map(([file]) => file)).toEqual([]);
  });

  it('log through logClientError with a fixed string-literal label', () => {
    const counts: Record<string, number> = {};
    for (const [file, text] of sources) {
      const calls = text.match(/\blogClientError\(/g) ?? [];
      const literal = text.match(/\blogClientError\(\s*(['"])[^'"`$\\]*\1\s*,/g) ?? [];
      expect({ file, calls: calls.length }).toEqual({ file, calls: literal.length });
      if (calls.length > 0) counts[file] = calls.length;
    }
    expect(counts).toEqual(SITES);
  });
});

describe('representative S2b sites log no part of the error (HAP-1210 S2b)', () => {
  it('AgentList: a failed apiClient request', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(axiosError('ERR_BAD_RESPONSE', 500));
    render(createElement(AgentList));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('[ERROR] Error fetching agents:', { errorClass: 'AxiosError', status: 500 }));
  });

  it('CredentialForm: an uploaded credential file that is not JSON', async () => {
    const protocol = Object.keys(PROTOCOL_DISPLAY_NAMES).find((p) => /^gcp_/.test(p));
    const credential = { id: 'c1', name: 'n', protocol, scope: 'universal', credentials: {}, tags: [] } as never;
    render(createElement(CredentialForm, { credential, onSubmit: vi.fn(), onCancel: vi.fn() }));
    fireEvent.change(document.getElementById('file_upload')!, { target: { files: [{ text: async () => MARK }] } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('[ERROR] Failed to parse JSON file', { errorClass: 'SyntaxError' }));
  });

  it('useWebSocket: a server message that is not JSON', () => {
    const sockets: { onmessage: (event: { data: string }) => void }[] = [];
    vi.stubGlobal('WebSocket', class { constructor() { sockets.push(this as never); } close() {} });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(AuthContext.Provider, { value: { token: TOK } as never }, children);
    renderHook(() => useWebSocket({ reconnect: false }), { wrapper });
    sockets[0].onmessage({ data: MARK });
    expect(spy).toHaveBeenCalledWith('[ERROR] Failed to parse WebSocket message', { errorClass: 'SyntaxError' });
  });
});
