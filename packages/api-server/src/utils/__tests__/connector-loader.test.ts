// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'fs';
import { logger } from '@cmdb/common';
import { fork } from 'child_process';
import { join } from 'path';
import { getPostgresClient } from '@cmdb/database';
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

describe('connector registration', () => {
  const query = jest.fn();

  async function register(manifest: Record<string, unknown>): Promise<void> {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(manifest));
    (getPostgresClient as jest.Mock).mockReturnValue({ pool: { query } });
    await new ConnectorLoader('/connectors').loadConnector('acme');
  }

  // [registry cache INSERT params, installed_connectors INSERT params]
  function insertedParams(): [unknown[], unknown[]] {
    expect(query).toHaveBeenCalledTimes(2);
    return [query.mock.calls[0][1], query.mock.calls[1][1]];
  }

  const BASE = { id: 'acme', type: 'acme', name: 'Acme', version: '1.0.0', description: 'd', category: 'CONNECTOR' };
  // $9 homepage, $10 repository in the cache INSERT; $8 is the serialised manifest in the installed INSERT.
  const HOMEPAGE = 8;
  const REPOSITORY = 9;
  const MANIFEST = 7;

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it('stores empty URLs in both tables and warns once per field when the manifest URLs are unsafe', async () => {
    const manifest = { ...BASE, homepage: 'javascript:alert(1)', repository: 'https://u:p@host/r' };
    await register(manifest);
    const [cache, installed] = insertedParams();

    expect(cache[HOMEPAGE]).toBe('');
    expect(cache[REPOSITORY]).toBe('');
    const stored = JSON.parse(installed[MANIFEST] as string);
    expect(stored.homepage).toBe('');
    expect(stored.repository).toBe('');

    expect((logger.warn as jest.Mock).mock.calls).toEqual([
      ['Connector manifest URL rejected', { field: 'homepage' }],
      ['Connector manifest URL rejected', { field: 'repository' }],
    ]);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toMatch(/javascript|host/);

    // The manifest object handed to the registration step must not be written back to.
    const kept = { ...BASE, homepage: 'javascript:alert(1)', repository: 'https://u:p@host/r' };
    const copyBefore = structuredClone(kept);
    query.mockClear();
    await new ConnectorLoader('/connectors')['registerConnectorInDatabase'](kept, '/connectors/acme');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1][HOMEPAGE]).toBe('');
    expect(kept).toEqual(copyBefore);
  });

  it('stores the normalised hrefs in both tables and does not warn for a clean manifest', async () => {
    await register({ ...BASE, homepage: ' https://Example.test ', repository: 'https:/api/v1/x' });
    const [cache, installed] = insertedParams();

    expect(cache[HOMEPAGE]).toBe('https://example.test/');
    expect(cache[REPOSITORY]).toBe('https://api/v1/x');
    const stored = JSON.parse(installed[MANIFEST] as string);
    expect(stored.homepage).toBe('https://example.test/');
    expect(stored.repository).toBe('https://api/v1/x');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps absent URLs absent in the stored manifest and empty in the cache, without a warning', async () => {
    await register({ ...BASE });
    const [cache, installed] = insertedParams();

    expect(cache[HOMEPAGE]).toBe('');
    expect(cache[REPOSITORY]).toBe('');
    const stored = JSON.parse(installed[MANIFEST] as string);
    expect(stored).not.toHaveProperty('homepage');
    expect(stored).not.toHaveProperty('repository');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('registry cache upsert', () => {
  const BASE = { id: 'acme', type: 'acme', name: 'Acme', version: '1.0.0', description: 'd', category: 'CONNECTOR' };
  const query = jest.fn();

  async function register(manifest: Record<string, unknown>): Promise<void> {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(manifest));
    (getPostgresClient as jest.Mock).mockReturnValue({ pool: { query } });
    await new ConnectorLoader('/connectors').loadConnector('acme');
  }

  // PGlite (PostgreSQL compiled to WASM) in a child process, as the other real-SQL unit tests do.
  const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
  let serial = 0;
  const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
  host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
    const reply = pending.get(id)!;
    pending.delete(id);
    if (error) reply.reject(new Error(error));
    else reply.resolve(rows);
  });
  function sql(text: string, params: unknown[] = [], mode: 'query' | 'exec' = 'query'): Promise<unknown[]> {
    const id = serial++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
    pending.set(id, { resolve, reject });
    host.send({ id, op: mode, sql: text, params });
    return promise;
  }

  beforeAll(async () => {
    const actualFs = jest.requireActual<typeof fs>('fs');
    const schema = actualFs.readFileSync(
      join(__dirname, '../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS connector_registry_cache \([\s\S]*?\n\);/);
    if (!ddl) throw new Error('Missing connector_registry_cache DDL');
    await sql(ddl[0], [], 'exec');
  }, 30000);
  afterAll(() => { host.kill(); });

  beforeEach(async () => {
    await sql('DELETE FROM connector_registry_cache', [], 'exec');
    // The cache statement runs against the real table; the installed_connectors statement is not under test.
    query.mockImplementation(async (text: string, params: unknown[]) =>
      text.includes('INSERT INTO connector_registry_cache')
        ? { rows: await sql(text, params) }
        : { rows: [] });
  });

  const SEED = `INSERT INTO connector_registry_cache (connector_type, category, name, latest_version, versions, homepage, repository)
    VALUES ('acme', 'CONNECTOR', 'Old', '0.9.0', '[]', 'javascript:alert(1)', 'https://u:p@evil.test/')`;
  const stored = () => sql('SELECT homepage, repository, name FROM connector_registry_cache WHERE connector_type = \'acme\'');

  it('binds the sanitised homepage and repository parameters in the cache upsert', async () => {
    await register({ ...BASE, homepage: 'javascript:alert(1)', repository: 'https://example.test/r' });

    expect(query.mock.calls[0][1][8]).toBe('');
    expect(query.mock.calls[0][1][9]).toBe('https://example.test/r');
  });

  it('replaces an unsafe URL already stored in the cache with the sanitised value', async () => {
    await sql(SEED, [], 'exec');
    await register({ ...BASE, homepage: 'javascript:alert(1)', repository: 'https://example.test/r' });

    expect(await stored()).toEqual([{ homepage: '', repository: 'https://example.test/r', name: 'Acme' }]);
  });

  it('clears a stored URL when the manifest no longer carries one', async () => {
    await sql(SEED, [], 'exec');
    await register({ ...BASE });

    expect(await stored()).toEqual([{ homepage: '', repository: '', name: 'Acme' }]);
  });
});
