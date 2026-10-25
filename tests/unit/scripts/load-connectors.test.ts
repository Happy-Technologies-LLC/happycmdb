// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-964: scripts/load-connectors.ts (deploy.sh connector-load step) resolves its real logger and
// never logs the raw loader error. ConnectorLoader is mocked: no PostgreSQL client, no writes.

import { afterEach, expect, it, jest } from '@jest/globals';
import { join } from 'path';
import { inspect } from 'util';

const ROOT = join(__dirname, '../../..');
const savedArgv = process.argv;

afterEach(() => { process.argv = savedArgv; }); // spies: restoreMocks in jest.config.unit.js

async function runScript(loadAllConnectors: () => Promise<void>) {
  const clearAllConnectors = jest.fn(async () => undefined);
  const logged: unknown[][] = [];
  process.argv = ['node', 'scripts/load-connectors.ts'];
  const code = await new Promise(resolve => {
    jest.spyOn(process, 'exit').mockImplementation(resolve as never);
    jest.isolateModules(() => {
      jest.doMock(join(ROOT, 'packages/api-server/src/utils/connector-loader'), () => ({
        ConnectorLoader: jest.fn(() => ({ clearAllConnectors, loadAllConnectors })),
      }));
      const { logger } = require(join(ROOT, 'packages/common/src/utils/logger'));
      for (const level of ['info', 'error'] as const) {
        jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => logged.push([level, ...args])) as never);
      }
      require(join(ROOT, 'scripts/load-connectors.ts'));
    });
  });
  return { code, clearAllConnectors, errors: logged.filter(([level]) => level === 'error'), logged };
}

it('loads connectors without clearing and exits 0', async () => {
  const loadAllConnectors = jest.fn(async () => undefined);
  const { code, clearAllConnectors, errors } = await runScript(loadAllConnectors);
  expect(code).toBe(0);
  expect(loadAllConnectors).toHaveBeenCalledTimes(1);
  expect(clearAllConnectors).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
});

it('exits 1 without logging the raw loader error', async () => {
  const { code, errors, logged } = await runScript(async () => {
    throw new Error('password authentication failed for user DO_NOT_LEAK');
  });
  expect(code).toBe(1);
  expect(errors).toEqual([['error', 'Fatal error loading connectors']]);
  expect(inspect(logged, { depth: 10 })).not.toContain('DO_NOT_LEAK');
});
