// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1575: startServer runs the role guard before anything starts listening or writes, and a refusal stops startup.
const order: string[] = [];
const pool = { marker: 'pool' };
const checkDbRole = jest.fn();
let exit: jest.SpyInstance;

jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => ({ pool }), startJournalSweeper: jest.fn() }));
jest.mock('@cmdb/discovery-engine', () => ({
  getDiscoveryOrchestrator: () => ({ start: async () => { order.push('discovery'); } }),
  startAISyncC4: async () => undefined,
}));
jest.mock('@cmdb/ai-ml-engine', () => ({ getAnomalyDetectionEngine: () => ({ loadConfiguration: async () => undefined }) }));
jest.mock('../utils/connector-loader', () => ({ loadConnectorsAtStartup: async () => { order.push('connectors'); } }));
jest.mock('../services/websocket.service', () => ({ getWebSocketService: () => ({ initialize: jest.fn() }) }));
jest.mock('../graphql/server', () => ({ createGraphQLServer: async () => undefined }));
jest.mock('../rest/routes/ci.routes', () => ({}));
jest.mock('../rest/routes/discovery.routes', () => ({}));
jest.mock('../rest/routes/relationship.routes', () => ({}));
jest.mock('../rest/routes/reconciliation.routes', () => ({}));
jest.mock('../rest/controllers/ci.controller', () => ({}));
jest.mock('../rest/controllers/reconciliation.controller', () => ({}));
jest.mock('../rest/server', () => ({
  listenTargetFromEnv: () => ({ port: 0, host: '127.0.0.1' }),
  RestAPIServer: class {
    setupErrorHandling() {}
    getApp() { return {}; }
    start() { order.push('listen'); return {}; }
  },
}));
jest.mock('../db-role-guard', () => ({
  checkDbRole: (...args: unknown[]) => checkDbRole(...args),
}));

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }); // startServer arms an hourly interval
  order.length = 0;
  exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  jest.resetModules();
});

afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('the guard runs on the API pool before connectors load and before the server listens', async () => {
  checkDbRole.mockImplementation(async () => { order.push('guard'); });
  jest.isolateModules(() => { require('../index'); });
  await settle();
  expect(checkDbRole).toHaveBeenCalledWith(pool);
  expect(order.slice(0, 3)).toEqual(['guard', 'connectors', 'listen']);
  expect(exit).not.toHaveBeenCalled();
});

test('a refusal from the guard exits non-zero and nothing loads or listens', async () => {
  checkDbRole.mockRejectedValue(new Error('refusing to start'));
  jest.isolateModules(() => { require('../index'); });
  await settle();
  expect(order).toEqual([]);
  expect(exit).toHaveBeenCalledWith(1);
});
