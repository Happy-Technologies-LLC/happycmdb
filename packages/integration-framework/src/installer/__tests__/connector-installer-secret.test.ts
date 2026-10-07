// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { logger } from '@cmdb/common';
import * as fs from 'fs';
import * as https from 'https';
import { ConnectorInstaller } from '../connector-installer';

jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('https', () => ({ get: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdir: jest.fn((_path, _options, callback: (error: null) => void) => callback(null)),
}));
jest.mock('../../registry/connector-registry', () => ({ getConnectorRegistry: () => ({}) }));
beforeEach(() => {
  (fs.mkdir as jest.Mock).mockImplementation(
    (_path, _options, callback: (error: null) => void) => callback(null)
  );
});

it('rejects credential-bearing signed URLs before network access without exposing URL bytes', async () => {
  const secret = 'INSTALLER_URL_SENTINEL';
  const url = `https://user:${secret}@github.com/org/connector.tgz?token=${secret}`;
  const installer = ConnectorInstaller.getInstance('/unused-test-connector-dir');

  let failure: unknown;
  try {
    await installer.downloadConnector('test-connector', { url });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Connector download failed');
  expect(https.get).not.toHaveBeenCalled();
  expect(JSON.stringify([(logger.info as jest.Mock).mock.calls, (logger.error as jest.Mock).mock.calls]))
    .not.toContain(secret);
});
