// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { httpProbeTool } from '../http-tool';
import { safeDiscoveryHttp } from '../safe-http';

jest.mock('../safe-http', () => ({ safeDiscoveryHttp: jest.fn() }));

const ok = { status: 200, statusText: 'OK', headers: {}, data: 'ready', config: {} };

beforeEach(() => {
  jest.mocked(safeDiscoveryHttp).mockReset();
  jest.mocked(safeDiscoveryHttp).mockResolvedValue(ok as never);
});

/** The URL's authority is host:port: no model-supplied part may change which host is contacted. */
describe('http_probe keeps the request on the named host', () => {
  it.each([
    ['a path that starts a userinfo section', { path: '@other.example/' }],
    ['a path without a leading slash', { path: 'x' }],
    ['a backslash path', { path: '\\@other.example/' }],
    ['a protocol carrying a URL', { protocol: 'http://other.example/#' }],
    ['an unknown protocol', { protocol: 'ftp' }],
    ['a string port', { port: '80@other.example' }],
    ['a fractional port', { port: 80.5 }],
    ['a port above 65535', { port: 65536 }],
    ['a negative port', { port: -1 }],
  ])('refuses %s without sending a request', async (_label, extra) => {
    await expect(httpProbeTool.execute({ host: '8.8.8.8', ...extra })).rejects.toThrow('Invalid HTTP probe parameters');
    expect(safeDiscoveryHttp).not.toHaveBeenCalled();
  });

  it('still builds host:port plus path for valid input', async () => {
    await httpProbeTool.execute({ host: '8.8.8.8', protocol: 'https', port: 8443, path: '/a/b?c=d' });

    expect(jest.mocked(safeDiscoveryHttp).mock.calls[0][0]).toBe('https://8.8.8.8:8443/a/b?c=d');
  });

  it('defaults to http, port 80 and path /', async () => {
    await httpProbeTool.execute({ host: '8.8.8.8' });

    expect(jest.mocked(safeDiscoveryHttp).mock.calls[0][0]).toBe('http://8.8.8.8:80/');
  });
});
