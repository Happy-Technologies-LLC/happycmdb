// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { createServer, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connectDiscoveryHost, resolveDiscoveryHost } from '@cmdb/common';
import {
  DISCOVERY_HTTP_MAX_BYTES,
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

  it.each([10 * MIB, Infinity, -1])('ignores options.maxContentLength = %p above the cap', async limit => {
    sendBody(2 * MIB);
    await expect(outcome(safeDiscoveryHttp(url(), { maxContentLength: limit }))).resolves.toEqual({ error: TOO_LARGE });
  });
});

describe('deadlines', () => {
  it('cuts off a drip-feeding server at the total deadline without leaking the URL', async () => {
    let timer: NodeJS.Timeout | undefined;
    handler = response => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      timer = setInterval(() => response.write('x'), 100);
      response.once('close', () => clearInterval(timer));
    };

    const started = Date.now();
    const error = await safeDiscoveryHttp(url(), { timeout: 5000, totalMs: 300 })
      .then(() => undefined, (e: Error) => e);
    const elapsed = Date.now() - started;
    clearInterval(timer);

    expect(error?.message).toBe(DEADLINE);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/probe-target|127\.0\.0\.1/);
    expect(elapsed).toBeLessThan(2000);
  }, 4000);

  it('still applies the idle timeout to a server that sends nothing', async () => {
    handler = () => { /* never respond */ };
    const error = await safeDiscoveryHttp(url(), { timeout: 200 }).then(() => undefined, (e: any) => e);
    expect(error?.code).toBe('ECONNABORTED');
  }, 4000);
});
