// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-774 S8 follow-up: the definition run builder queues a credential-free payload and refuses
// unsafe stored config before enqueue. Only the DB client and the BullMQ queue are mocked.
const SENTINEL = ['V', 'S8', 'FU', String(new Date(0).getUTCFullYear())].join('-');
const FORBIDDEN = /credential|password|passphrase|privatekey|secret/i;
const keysDeep = (value: unknown): string[] => (value && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]) : []);
const mockAdded: Array<[string, Record<string, unknown>, unknown]> = [];
let mockConfig: unknown;
let mockBound: Record<string, string> = {};
const mockSql: string[] = [];
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ getClient: async () => ({
    query: async (sql: string) => (mockSql.push(sql), { rows: sql.includes('FROM discovery_definitions') ? [{
      id: 'd1', name: 'n', provider: 'nmap', method: 'agentless', credential_id: null, credential_set_id: null, ...mockBound,
      config: mockConfig, schedule: null, is_active: true, tags: [], created_by: 'u',
      created_at: new Date(0), updated_at: new Date(0),
    }] : [] }),
    release: () => undefined,
  }) }),
  queueManager: { getQueue: () => ({
    add: async (name: string, data: Record<string, unknown>, opts: unknown) => { mockAdded.push([name, data, opts]); },
  }) },
}));
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common/utils/discovery-scan-config'),
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

import { randomUUID } from 'crypto';
import { DiscoveryDefinitionService } from '../discovery-definition.service';

beforeEach(() => { mockAdded.length = 0; mockSql.length = 0; mockBound = {}; });
afterEach(() => { expect(JSON.stringify(mockAdded)).not.toContain(SENTINEL); });

it('runDefinition queues only targets and scan modes for a valid definition', async () => {
  mockConfig = { targets: ['192.0.2.10'], scanOptions: { serviceDetection: true } };
  await expect(new DiscoveryDefinitionService().runDefinition('d1', 'u', 'org')).resolves.toMatch(/^nmap-/);
  expect(mockAdded).toHaveLength(1);
  expect(mockAdded[0][1]).toMatchObject({ provider: 'nmap', definition_id: 'd1', organizationId: 'org' });
  expect(mockAdded[0][1].config).toStrictEqual(mockConfig);
  expect(keysDeep(mockAdded).filter((key) => FORBIDDEN.test(key))).toEqual([]);
});

it.each([
  ['object credentials', { credentials: { password: SENTINEL } }],
  ['string credentials', { credentials: SENTINEL }],
  ['credentialsId', { credentialsId: SENTINEL }],
  ['scanOptions.password', { scanOptions: { password: SENTINEL } }],
  ['top-level privateKey', { privateKey: SENTINEL }],
])('runDefinition refuses stored %s before enqueue', async (_shape, unsafe) => {
  mockConfig = { targets: ['192.0.2.10'], ...unsafe };
  await expect(new DiscoveryDefinitionService().runDefinition('d1', 'u', 'org'))
    .rejects.toThrow(/Unsafe legacy discovery configuration/);
  expect(mockAdded).toEqual([]);
});

it.each([
  ['credential_id', ['credential_id']],
  ['credential_set_id', ['credential_set_id']],
  ['credential_id and credential_set_id', ['credential_id', 'credential_set_id']],
])('runDefinition refuses a %s-bound definition before enqueue or last-run update', async (_shape, columns) => {
  const ref = randomUUID();
  mockConfig = { targets: ['192.0.2.10'], scanOptions: { serviceDetection: true } };
  mockBound = Object.fromEntries(columns.map((column) => [column, ref]));
  const error = await new DiscoveryDefinitionService().runDefinition('d1', 'u', 'org').catch((caught: Error) => caught);
  expect(error).toEqual(new Error('Credential-backed discovery execution is unavailable'));
  expect(`${(error as Error).message}\n${(error as Error).stack}`).not.toContain(ref);
  expect(mockAdded).toEqual([]);
  expect(mockSql.filter((sql) => /^\s*UPDATE\b/i.test(sql))).toEqual([]);
});
