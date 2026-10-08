// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { execFile } from 'child_process';
import { Client } from 'ssh2';
import { nmapTool } from '../nmap-tool';
import { sshExecuteTool } from '../ssh-tool';
import { DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('ssh2', () => ({ Client: jest.fn() }));
const mockedLookup = jest.mocked(lookup);

beforeEach(() => {
  mockedLookup.mockReset();
  jest.mocked(execFile).mockClear();
  jest.mocked(Client).mockClear();
});

it('nmap tool refuses private and injected targets without starting a subprocess', async () => {
  for (const host of ['127.0.0.1', '169.254.169.254', 'redis', '8.8.8.8;id']) {
    await expect(nmapTool.execute({ host, ports: '80' })).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  }
  expect(execFile).not.toHaveBeenCalled();
  expect(mockedLookup).not.toHaveBeenCalled();
});

it('nmap and SSH tools refuse a public hostname rebound to an internal IP before process or socket', async () => {
  for (const tool of [nmapTool, sshExecuteTool]) {
    mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '10.1.1.1', family: 4 }] as never);
    await expect(tool.execute({ host: 'public.example', ports: '80', username: 'test', command: 'whoami' }))
      .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  }
  expect(execFile).not.toHaveBeenCalled();
  expect(Client).not.toHaveBeenCalled();
});
