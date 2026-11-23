// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { createServer, Server, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { connectDiscoveryHost, resolveDiscoveryHost } from '@cmdb/common';
import {
  DISCOVERY_HTTP_FAILED,
  DISCOVERY_HTTP_MAX_BYTES,
  DISCOVERY_HTTP_TOTAL_MS,
  DISCOVERY_RESPONSE_DEADLINE,
  DISCOVERY_RESPONSE_TOO_LARGE,
  safeDiscoveryHttp,
} from '../safe-http';

// Real axios + real Node agent against an in-process loopback server. The policy
// resolver is replaced only to let the transport reach the fixture; egress
// refusal is covered by safe-http-egress.test.ts.
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  resolveDiscoveryHost: jest.fn(),
  connectDiscoveryHost: jest.fn(),
}));

const MIB = 1024 * 1024;
const TOO_LARGE = DISCOVERY_RESPONSE_TOO_LARGE;
const DEADLINE = DISCOVERY_RESPONSE_DEADLINE;

let server: Server;
let port: number;
let handler: (response: ServerResponse) => void;

beforeEach(async () => {
  jest.mocked(resolveDiscoveryHost).mockResolvedValue('127.0.0.1');
  jest.mocked(connectDiscoveryHost).mockResolvedValue('127.0.0.1');
  server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const url = () => `http://probe-target.example:${port}/health`;

function sendBody(bytes: number): void {
  handler = response => {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': bytes });
    response.end('a'.repeat(bytes));
  };
}

/** Resolves when the server-side TCP socket for this response is gone. */
const socketClosed = (response: ServerResponse): Promise<void> =>
  new Promise<void>(resolve => {
    const socket = response.socket;
    if (!socket || socket.destroyed) resolve(); else socket.once('close', () => resolve());
  });

const outcome = (promise: Promise<{ data: string }>) =>
  promise.then(
    result => ({ length: result.data.length }),
    (error: Error) => ({ error: error.message }),
  );

describe('response size cap', () => {
  it('rejects a chunked 5 MiB stream with a fixed message and stops the server writing early', async () => {
    const chunk = Buffer.alloc(64 * 1024, 97);
    const total = 5 * MIB;
    let written = 0;
    let finished = false;
    let closed: Promise<void> = Promise.resolve();
    handler = response => {
      closed = new Promise<void>(resolve => response.once('close', resolve));
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      const pump = (): void => {
        if (response.destroyed || response.writableEnded) return;
        if (written >= total) { finished = true; response.end(); return; }
        response.write(chunk, () => { written += chunk.length; setTimeout(pump, 5); });
      };
      pump();
    };

    const result = await outcome(safeDiscoveryHttp(url()));
    await closed;

    expect(result).toEqual({ error: TOO_LARGE });
    expect(finished).toBe(false);
    expect(written).toBeLessThan(total / 2);
  });

  it('keeps the fixed message free of the target URL and body text', async () => {
    sendBody(2 * MIB);
    const error = await safeDiscoveryHttp(url()).then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe(TOO_LARGE);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/probe-target|127\.0\.0\.1|aaaa/);
  });

  it('passes a body just under the cap unchanged', async () => {
    sendBody(DISCOVERY_HTTP_MAX_BYTES - 1);
    await expect(outcome(safeDiscoveryHttp(url()))).resolves.toEqual({ length: DISCOVERY_HTTP_MAX_BYTES - 1 });
  });

  it('honours options.maxContentLength below the cap', async () => {
    sendBody(2000);
    await expect(outcome(safeDiscoveryHttp(url(), { maxContentLength: 1000 }))).resolves.toEqual({ error: TOO_LARGE });
    sendBody(500);
    await expect(outcome(safeDiscoveryHttp(url(), { maxContentLength: 1000 }))).resolves.toEqual({ length: 500 });
  });

  it('rejects a gzip body that inflates past the cap although the wire size is tiny', async () => {
    const wire = gzipSync(Buffer.alloc(2 * MIB, 97));
    expect(wire.length).toBeLessThan(DISCOVERY_HTTP_MAX_BYTES / 100);
    handler = response => {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': wire.length });
      response.end(wire);
    };
    const error = await safeDiscoveryHttp(url()).then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe(TOO_LARGE);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/probe-target|127\.0\.0\.1/);
  });

  it('does not report a server reset mid-body as too large, and never leaks the URL', async () => {
    handler = response => {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 100000 });
      response.write('partial', () => response.socket?.destroy());
    };
    const error = await safeDiscoveryHttp(url()).then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe(DISCOVERY_HTTP_FAILED);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/probe-target|127\.0\.0\.1|health/);
  });

  it.each([10 * MIB, Infinity, -1])('ignores options.maxContentLength = %p above the cap', async limit => {
    sendBody(2 * MIB);
    await expect(outcome(safeDiscoveryHttp(url(), { maxContentLength: limit }))).resolves.toEqual({ error: TOO_LARGE });
  });
});

describe('deadlines', () => {
  it('cuts off a drip-feeding server at the total deadline without leaking the URL', async () => {
    let timer: NodeJS.Timeout | undefined;
    let closed: Promise<void> = Promise.resolve();
    handler = response => {
      closed = socketClosed(response);
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      timer = setInterval(() => response.write('x'), 100);
      response.once('close', () => clearInterval(timer));
    };

    const started = Date.now();
    const error = await safeDiscoveryHttp(url(), { timeout: 5000, totalMs: 300 })
      .then(() => undefined, (e: Error) => e);
    const elapsed = Date.now() - started;
    await closed; // the client tore the connection down, not just rejected
    clearInterval(timer);

    expect(error?.message).toBe(DEADLINE);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/probe-target|127\.0\.0\.1/);
    expect(elapsed).toBeLessThan(2000);
  }, 4000);

  it('cuts off a server that accepts the request but never sends headers', async () => {
    let closed: Promise<void> = Promise.resolve();
    handler = response => { closed = socketClosed(response); };
    const started = Date.now();
    const error = await safeDiscoveryHttp(url(), { timeout: 5000, totalMs: 300 })
      .then(() => undefined, (e: Error) => e);
    const elapsed = Date.now() - started;
    await closed;
    expect(error?.message).toBe(DEADLINE);
    expect(elapsed).toBeLessThan(2000);
  }, 4000);

  it('bounds a DNS step that never answers by the same total deadline, before any connection', async () => {
    let requests = 0;
    handler = () => { requests += 1; };
    jest.mocked(resolveDiscoveryHost).mockReturnValue(new Promise<string>(() => undefined));
    const started = Date.now();
    const error = await safeDiscoveryHttp(url(), { timeout: 5000, totalMs: 300 })
      .then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe(DEADLINE);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(requests).toBe(0);
  }, 4000);

  it('spends DNS time out of the same budget as the request', async () => {
    handler = response => response.end('ok');
    jest.mocked(resolveDiscoveryHost).mockImplementation(
      () => new Promise<string>(resolve => setTimeout(() => resolve('127.0.0.1'), 400)));
    const error = await safeDiscoveryHttp(url(), { totalMs: 300 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe(DEADLINE);
  }, 4000);

  it('still applies the idle timeout to a server that sends nothing', async () => {
    handler = () => { /* never respond */ };
    const error = await safeDiscoveryHttp(url(), { timeout: 200 }).then(() => undefined, (e: any) => e);
    expect(error?.code).toBe('ECONNABORTED');
    expect(error?.message).toBe(DISCOVERY_HTTP_FAILED);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/probe-target|127\.0\.0\.1|health/);
  }, 4000);

  describe('totalMs can only lower the deadline', () => {
    const appliedDeadline = async (totalMs: number | undefined): Promise<number | undefined> => {
      handler = response => response.end('ok');
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      try {
        // A 1 ms deadline legitimately expires; only the applied value matters here.
        await safeDiscoveryHttp(url(), totalMs === undefined ? {} : { totalMs }).catch(() => undefined);
        return timeout.mock.calls[0]?.[0];
      } finally {
        timeout.mockRestore();
      }
    };

    it.each([1e9, Infinity, 15001])('clamps %p to the default', async requested => {
      expect(await appliedDeadline(requested)).toBe(DISCOVERY_HTTP_TOTAL_MS);
    });
    it.each([NaN, -5, 0, undefined])('falls back to the default for %p', async requested => {
      expect(await appliedDeadline(requested)).toBe(DISCOVERY_HTTP_TOTAL_MS);
    });
    it('keeps a lower value, floored to whole milliseconds and at least 1', async () => {
      expect(await appliedDeadline(300.9)).toBe(300);
      expect(await appliedDeadline(0.4)).toBe(1);
    });
  });
});
