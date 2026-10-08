// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import { Client } from 'ssh2';
import { logger } from '@cmdb/common';
import { sshExecuteTool } from '../ssh-tool';
import { httpProbeTool } from '../http-tool';
import { safeDiscoveryHttp } from '../safe-http';

jest.mock('ssh2', () => ({ Client: jest.fn() }));
jest.mock('../safe-http', () => ({ safeDiscoveryHttp: jest.fn() }));

const secret = 'SENSITIVE-TEST-VALUE';
afterEach(() => jest.restoreAllMocks());

it('does not log caller-controlled SSH command text', async () => {
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.mocked(Client).mockImplementation(() => { throw new Error('halt before socket'); });
  await expect(sshExecuteTool.execute({ host: '8.8.8.8', username: 'operator',
    command: `echo password=${secret}` })).rejects.toThrow('halt before socket');
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});

it('does not propagate SSH errors that echo sensitive command text', async () => {
  const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const conn = new EventEmitter() as EventEmitter & { connect: () => EventEmitter };
  conn.connect = () => {
    queueMicrotask(() => conn.emit('error', new Error(`remote echoed ${secret}`)));
    return conn;
  };
  jest.mocked(Client).mockImplementation(() => conn as never);
  await expect(sshExecuteTool.execute({ host: '8.8.8.8', username: 'operator',
    command: `echo password=${secret}` })).rejects.not.toThrow(secret);
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
});

it('logs SSH exit code without reflecting an untrusted exit signal', async () => {
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  const conn = new EventEmitter() as EventEmitter & {
    connect: () => EventEmitter;
    exec: (command: string, callback: (error: null, stream: EventEmitter) => void) => void;
    end: () => void;
  };
  conn.connect = () => {
    queueMicrotask(() => conn.emit('ready'));
    return conn;
  };
  conn.exec = (_command, callback) => {
    const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    stream.stderr = new EventEmitter();
    callback(null, stream);
    queueMicrotask(() => stream.emit('close', 1, `SIG-${secret}`));
  };
  conn.end = jest.fn();
  jest.mocked(Client).mockImplementation(() => conn as never);
  const result = await sshExecuteTool.execute({ host: '8.8.8.8', username: 'operator',
    command: `echo ${secret}` });
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});

it('does not log HTTP path/query credentials on successful probes', async () => {
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.mocked(safeDiscoveryHttp).mockResolvedValueOnce({
    status: 200, statusText: 'OK', headers: {}, data: 'ready', config: {},
  } as never);
  const result = await httpProbeTool.execute({ host: '8.8.8.8',
    path: `/password/${secret}?token=${secret}` });
  expect(result.status).toBe(200);
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});

it('does not log or throw HTTP path/query credentials on network and setup failures', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const url = `http://8.8.8.8:80/password/${secret}?token=${secret}`;
  jest.mocked(safeDiscoveryHttp).mockRejectedValueOnce({ request: {}, message: `No response from ${url}` });
  await expect(httpProbeTool.execute({ host: '8.8.8.8',
    path: `/password/${secret}?token=${secret}` })).rejects.not.toThrow(secret);
  jest.mocked(safeDiscoveryHttp).mockRejectedValueOnce(new Error(`Invalid URL ${url}`));
  await expect(httpProbeTool.execute({ host: '8.8.8.8',
    path: `/password/${secret}?token=${secret}` })).rejects.not.toThrow(secret);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
});
