// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'fs';
import { logger } from '@cmdb/common';
import { ConnectorLoader } from '../connector-loader';

jest.mock('fs');
jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn(() => ({})) }));
jest.mock('@cmdb/common', () => ({ logger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));

it('does not log a connector path or a provider error containing credentials', async () => {
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  (fs.readdirSync as jest.Mock).mockReturnValue([{
    name: 'client_secret=DO_NOT_LEAK', isDirectory: () => true,
  }]);
  (fs.readFileSync as jest.Mock).mockImplementation(() => {
    throw new Error('provider credential client_secret=DO_NOT_LEAK');
  });

  await new ConnectorLoader('/path/client_secret=DO_NOT_LEAK').loadAllConnectors();
  for (const method of ['info', 'warn', 'error'] as const) {
    expect(JSON.stringify((logger[method] as jest.Mock).mock.calls)).not.toContain('DO_NOT_LEAK');
  }
  expect(logger.error).toHaveBeenCalledWith('Failed to load connector');
});
