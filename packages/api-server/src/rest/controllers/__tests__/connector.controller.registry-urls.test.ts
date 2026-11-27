// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry endpoints return `connector_registry_cache` rows. A stored `homepage`/`repository` written by
 * an older loader (or any other writer) must reach the client as a safe link or as `''`, never verbatim.
 */

import type { Request, Response } from 'express';

const mockQuery = jest.fn();

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  validateConnectorSortField: jest.fn(),
  validateSortDirection: jest.fn(),
}));
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: { query: (...args: unknown[]) => mockQuery(...args) } }),
}));

import { ConnectorController } from '../connector.controller';

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

function body(res: Response): any {
  expect(res.status).not.toHaveBeenCalled();
  return (res.json as jest.Mock).mock.calls[0][0];
}

const CASES: Array<[string, string | null, string | null]> = [
  ['javascript:alert(1)', 'javascript:alert(1)', ''],
  ['userinfo', 'https://user:pw@evil.test/', ''],
  ['backslashes', 'https:\\\\evil.test', 'https://evil.test/'],
  ['valid', 'https://example.test/x', 'https://example.test/x'],
  ['null', null, null],
  ['empty', '', ''],
];

function registryRow(homepage: string | null, repository: string | null) {
  return {
    connector_type: 'acme-crm',
    category: 'CONNECTOR',
    name: 'Acme CRM',
    description: 'd',
    verified: true,
    latest_version: '2.0.0',
    versions: [{ version: '2.0.0' }],
    author: 'a',
    homepage,
    repository,
    license: 'MIT',
    downloads: 7,
    rating: '4.50',
    tags: ['crm'],
  };
}

function expectRow(row: any, homepage: string | null, repository: string | null) {
  expect(row).toEqual({ ...registryRow(null, null), homepage, repository });
}

describe('ConnectorController registry reads re-sanitise stored URLs', () => {
  const controller = new ConnectorController();

  it.each(CASES)('GET /registry: %s', async (_label, stored, expected) => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [registryRow(stored, 'https://user:pw@evil.test/r')] });
    const res = mockRes();

    await controller.getRegistry({ query: {} } as unknown as Request, res);

    const out = body(res);
    expectRow(out.data[0], expected, '');
    expect(out.pagination).toEqual({ total: 1, count: 1, limit: 50, offset: 0 });
  });

  it.each(CASES)('GET /registry/:type: %s', async (_label, stored, expected) => {
    mockQuery.mockResolvedValueOnce({ rows: [registryRow('https://user:pw@evil.test/h', stored)] });
    const res = mockRes();

    await controller.getRegistryDetails({ params: { type: 'acme-crm' } } as unknown as Request, res);

    const out = body(res);
    expect(out.success).toBe(true);
    expectRow(out.data, '', expected);
  });

  it.each(CASES)('GET /registry/search: %s', async (_label, stored, expected) => {
    mockQuery.mockResolvedValueOnce({ rows: [registryRow(stored, stored), registryRow('javascript:alert(1)', 'https://u:p@evil.test/')] });
    const res = mockRes();

    await controller.searchRegistry({ query: { q: 'acme' } } as unknown as Request, res);

    const out = body(res);
    expect(out).toMatchObject({ success: true, count: 2, query: 'acme' });
    expectRow(out.data[0], expected, expected);
    expectRow(out.data[1], '', '');
  });
});
