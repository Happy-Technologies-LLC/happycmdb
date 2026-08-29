// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Data Mart Client Tests
 *
 * Regression coverage for F-229: `upsertCI` must skip creating a new SCD
 * Type 2 version when an incoming CI is identical to the current record,
 * and must still create one when a tracked attribute genuinely changes.
 */

import { DataMartClient } from '../../src/clients/datamart.client';
import { PostgresClient } from '../../src/postgres/client';
import type { CIDimensionInput } from '@cmdb/common';

jest.mock('../../src/postgres/client');

describe('DataMartClient.upsertCI', () => {
  let mockPgClient: jest.Mocked<PostgresClient>;
  let dataMartClient: DataMartClient;

  const baseCI: CIDimensionInput = {
    ci_id: 'ci-123',
    ciname: 'web-server-01',
    ci_type: 'server',
    ci_status: 'active',
    environment: 'production',
    external_id: 'ext-1',
    metadata: { rack: 'r1' },
  };

  // Row shape as actually returned by the driving SELECT in upsertCI, which
  // reads the real `dim_ci.ci_name` column (not `ciname`).
  const existingRow = {
    ci_key: 42,
    ci_name: baseCI.ciname,
    ci_type: baseCI.ci_type,
    ci_status: baseCI.ci_status,
    environment: baseCI.environment,
    external_id: baseCI.external_id,
    metadata: baseCI.metadata,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPgClient = new PostgresClient({
      _host: 'localhost',
      _port: 5432,
      _database: 'test',
      _user: 'test',
      _password: 'test',
    }) as jest.Mocked<PostgresClient>;
    dataMartClient = new DataMartClient(mockPgClient);
  });

  it('does not create a new version when the incoming CI is unchanged', async () => {
    mockPgClient.query = jest.fn().mockResolvedValue({ rows: [existingRow] });
    mockPgClient.updateCIDimension = jest.fn();

    const ciKey = await dataMartClient.upsertCI({ ...baseCI });

    expect(ciKey).toBe(existingRow.ci_key);
    expect(mockPgClient.updateCIDimension).not.toHaveBeenCalled();
  });

  it('creates a new version when the CI name genuinely changes', async () => {
    mockPgClient.query = jest.fn().mockResolvedValue({ rows: [existingRow] });
    mockPgClient.updateCIDimension = jest.fn().mockResolvedValue(43);

    const ciKey = await dataMartClient.upsertCI({
      ...baseCI,
      ciname: 'web-server-02',
    });

    expect(ciKey).toBe(43);
    expect(mockPgClient.updateCIDimension).toHaveBeenCalledTimes(1);
  });

  it('creates a new version when a non-name attribute changes', async () => {
    mockPgClient.query = jest.fn().mockResolvedValue({ rows: [existingRow] });
    mockPgClient.updateCIDimension = jest.fn().mockResolvedValue(44);

    const ciKey = await dataMartClient.upsertCI({
      ...baseCI,
      ci_status: 'maintenance',
    });

    expect(ciKey).toBe(44);
    expect(mockPgClient.updateCIDimension).toHaveBeenCalledTimes(1);
  });

  it('inserts a brand-new CI when no current record exists', async () => {
    mockPgClient.query = jest.fn().mockResolvedValue({ rows: [] });
    mockPgClient.insertCIDimension = jest.fn().mockResolvedValue(1);

    const ciKey = await dataMartClient.upsertCI({ ...baseCI });

    expect(ciKey).toBe(1);
    expect(mockPgClient.insertCIDimension).toHaveBeenCalledTimes(1);
  });
});
