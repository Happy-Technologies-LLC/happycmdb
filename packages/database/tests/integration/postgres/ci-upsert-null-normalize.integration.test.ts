// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoped repro/verification test for F-229 / E-089 residual defect fix.
 *
 * DataMartClient.hasCIChanged() used to compare optional fields with a bare
 * `!==`, so a stored SQL NULL (read back as JS `null`) never equaled an
 * omitted optional field (JS `undefined`), causing a spurious new SCD
 * Type-2 version on every upsertCI call for CIs whose caller omits an
 * optional field. This file verifies the nullish-normalization fix in
 * packages/database/src/clients/datamart.client.ts.
 *
 * Run scoped only, against the already-running live infra:
 *   npx jest --config packages/database/jest.config.js \
 *     --testPathPattern ci-upsert-null-normalize --runInBand
 */

import { PostgresClient } from '../../../src/postgres/client';
import { DataMartClient } from '../../../src/clients/datamart.client';
import type { CIDimensionInput } from '@cmdb/common';

const RUN_ID = `fix8-null-norm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const pgClient = new PostgresClient({
  _host: 'localhost',
  _port: 15432,
  _database: 'cmdb_test',
  _user: 'test',
  _password: 'testpassword',
});
const datamart = new DataMartClient(pgClient);

const createdCiIds: string[] = [];

afterAll(async () => {
  if (createdCiIds.length > 0) {
    await pgClient.query('DELETE FROM cmdb.dim_ci WHERE ci_id = ANY($1)', [createdCiIds]);
  }
  await pgClient.close();
});

describe('F-229/E-089 hasCIChanged nullish normalization', () => {
  test('omitting an optional field (external_id) on an unchanged CI creates no new version', async () => {
    const ciId = `${RUN_ID}-omitted-external-id`;
    createdCiIds.push(ciId);

    const input: CIDimensionInput = {
      ci_id: ciId,
      ciname: 'Fix8 CI No External Id',
      ci_type: 'server' as CIDimensionInput['ci_type'],
      ci_status: 'active' as CIDimensionInput['ci_status'],
    };

    const key1 = await datamart.upsertCI(input);
    const key2 = await datamart.upsertCI({ ...input });

    expect(key2).toBe(key1);

    const rows = await pgClient.query('SELECT COUNT(*) FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
    expect(parseInt(rows.rows[0].count, 10)).toBe(1);
  }, 20000);

  test('a real value -> null/omitted transition on external_id still creates a new version', async () => {
    const ciId = `${RUN_ID}-real-to-null`;
    createdCiIds.push(ciId);

    const withExternalId: CIDimensionInput = {
      ci_id: ciId,
      ciname: 'Fix8 CI Real To Null',
      ci_type: 'server' as CIDimensionInput['ci_type'],
      ci_status: 'active' as CIDimensionInput['ci_status'],
      external_id: 'EXT-123',
    };

    const key1 = await datamart.upsertCI(withExternalId);

    const { external_id, ...withoutExternalId } = withExternalId;
    void external_id;
    const key2 = await datamart.upsertCI(withoutExternalId as CIDimensionInput);

    expect(key2).not.toBe(key1);

    const rows = await pgClient.query('SELECT COUNT(*) FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
    expect(parseInt(rows.rows[0].count, 10)).toBe(2);
  }, 20000);

  test('a null/omitted -> real value transition on external_id still creates a new version', async () => {
    const ciId = `${RUN_ID}-null-to-real`;
    createdCiIds.push(ciId);

    const withoutExternalId: CIDimensionInput = {
      ci_id: ciId,
      ciname: 'Fix8 CI Null To Real',
      ci_type: 'server' as CIDimensionInput['ci_type'],
      ci_status: 'active' as CIDimensionInput['ci_status'],
    };

    const key1 = await datamart.upsertCI(withoutExternalId);
    const key2 = await datamart.upsertCI({ ...withoutExternalId, external_id: 'EXT-456' });

    expect(key2).not.toBe(key1);

    const rows = await pgClient.query('SELECT COUNT(*) FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
    expect(parseInt(rows.rows[0].count, 10)).toBe(2);
  }, 20000);

  test('a genuine ciname change still creates a new version (previously-verified behavior unaffected)', async () => {
    const ciId = `${RUN_ID}-name-change`;
    createdCiIds.push(ciId);

    const input: CIDimensionInput = {
      ci_id: ciId,
      ciname: 'Fix8 CI Original Name',
      ci_type: 'server' as CIDimensionInput['ci_type'],
      ci_status: 'active' as CIDimensionInput['ci_status'],
      environment: 'production' as CIDimensionInput['environment'],
    };

    const key1 = await datamart.upsertCI(input);
    const key2 = await datamart.upsertCI({ ...input, ciname: 'Fix8 CI Renamed' });

    expect(key2).not.toBe(key1);

    const rows = await pgClient.query('SELECT COUNT(*) FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
    expect(parseInt(rows.rows[0].count, 10)).toBe(2);
  }, 20000);

  test('a genuine ci_status change still creates a new version (previously-verified behavior unaffected)', async () => {
    const ciId = `${RUN_ID}-status-change`;
    createdCiIds.push(ciId);

    const input: CIDimensionInput = {
      ci_id: ciId,
      ciname: 'Fix8 CI Status Test',
      ci_type: 'server' as CIDimensionInput['ci_type'],
      ci_status: 'active' as CIDimensionInput['ci_status'],
    };

    const key1 = await datamart.upsertCI(input);
    const key2 = await datamart.upsertCI({ ...input, ci_status: 'retired' as CIDimensionInput['ci_status'] });

    expect(key2).not.toBe(key1);

    const rows = await pgClient.query('SELECT COUNT(*) FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
    expect(parseInt(rows.rows[0].count, 10)).toBe(2);
  }, 20000);

  test('omitting metadata on an unchanged CI creates no new version, but a real metadata change does', async () => {
    const ciId = `${RUN_ID}-metadata`;
    createdCiIds.push(ciId);

    const input: CIDimensionInput = {
      ci_id: ciId,
      ciname: 'Fix8 CI Metadata Test',
      ci_type: 'server' as CIDimensionInput['ci_type'],
      ci_status: 'active' as CIDimensionInput['ci_status'],
    };

    const key1 = await datamart.upsertCI(input);
    const key2 = await datamart.upsertCI({ ...input });
    expect(key2).toBe(key1);

    const key3 = await datamart.upsertCI({ ...input, metadata: { owner: 'team-a' } });
    expect(key3).not.toBe(key1);

    const key4 = await datamart.upsertCI({ ...input, metadata: { owner: 'team-a' } });
    expect(key4).toBe(key3);

    const rows = await pgClient.query('SELECT COUNT(*) FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
    expect(parseInt(rows.rows[0].count, 10)).toBe(2);
  }, 30000);
});
