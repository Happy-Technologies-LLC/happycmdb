// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { PoolClient } from 'pg';
import type { CIDimensionInput } from '@cmdb/common';
import { PostgresClient } from '../../../src/postgres/client';
import { DataMartClient } from '../../../src/clients/datamart.client';

const INTERNAL = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const pg = new PostgresClient({
  _host: process.env.POSTGRES_HOST || 'localhost',
  _port: Number(process.env.POSTGRES_PORT) || 5432,
  _database: process.env.POSTGRES_DB || 'cmdb_test',
  _user: process.env.POSTGRES_USER || 'test',
  _password: process.env.POSTGRES_PASSWORD || 'testpassword',
});
const datamart = new DataMartClient(pg);

// The integration runner supplies its disposable PostgreSQL database. Never
// run this test against a live database: it creates and deletes dim_ci rows.
afterAll(async () => { await pg.close(); });

test('two organizations cannot both claim the same backfilled CI concurrently', async () => {
  const ciId = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await pg.query(`INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, is_current, organization_id, org_backfilled, tbm_attributes)
    VALUES ($1, 'backfilled', 'server', 'active', TRUE, $2, TRUE, '{"monthly_cost":75}')`,
  [ciId, INTERNAL]);

  const base: CIDimensionInput = {
    ci_id: ciId, ciname: 'claimed', ci_type: 'server', ci_status: 'active',
    organization_id: ORG_A,
  };
  let outerReads = 0;
  let releaseOuter!: () => void;
  const bothOuterReads = new Promise<void>(resolve => { releaseOuter = resolve; });
  let releaseFirst!: () => void;
  const secondTransactionQuery = new Promise<void>(resolve => { releaseFirst = resolve; });
  let transactions = 0;
  let secondIssued = false;
  const rawQuery = pg.query.bind(pg);
  const rawGetClient = pg.getClient.bind(pg);
  const querySpy = jest.spyOn(pg, 'query').mockImplementation(async (sql, params) => {
    const result = await rawQuery(sql, params);
    // Both callers must see the same 011-backfilled row before either enters
    // its SCD transaction. This is the actual DataMartClient preflight read.
    if (sql.includes('SELECT ci_key, ci_name') && params?.[0] === ciId) {
      if (++outerReads === 2) releaseOuter();
      await bothOuterReads;
    }
    return result;
  });
  const clientSpy = jest.spyOn(pg, 'getClient').mockImplementation(async () => {
    const client = await rawGetClient();
    const order = ++transactions;
    const query = client.query.bind(client);
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          // First transaction pauses AFTER its current-row SELECT. The other
          // transaction has already sent its first SQL statement by release:
          // old code sends an unlocked SELECT and sees the backfill; a fixed
          // writer blocks at its per-CI lock until the first commits.
          if (order === 2 && sql !== 'BEGIN' && !secondIssued) {
            secondIssued = true;
            const pending = query(sql, params ?? []);
            releaseFirst();
            return pending;
          }
          const result = await query(sql, params ?? []);
          if (order === 1 && sql.includes('SELECT organization_id, org_backfilled FROM cmdb.dim_ci')) {
            await secondTransactionQuery;
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
  });

  try {
    const claims = await Promise.allSettled([
      datamart.upsertCI(base),
      datamart.upsertCI({ ...base, ciname: 'claimed B', organization_id: ORG_B }),
    ]);
    const winners = claims.filter(c => c.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(claims.filter(c => c.status === 'rejected')).toHaveLength(1);

    const expectedOrg = claims[0].status === 'fulfilled' ? ORG_A : ORG_B;
    const current = await rawQuery(`SELECT organization_id, ci_name,
      tbm_attributes->>'monthly_cost' AS monthly_cost
      FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE`, [ciId]);
    expect(current.rows).toEqual([{
      organization_id: expectedOrg,
      ci_name: expectedOrg === ORG_A ? 'claimed' : 'claimed B',
      monthly_cost: '0',
    }]);
    const backfill = await rawQuery(`SELECT organization_id, tbm_attributes->>'monthly_cost' AS monthly_cost
      FROM cmdb.dim_ci WHERE ci_id = $1 AND org_backfilled = FALSE AND is_current = FALSE`, [ciId]);
    expect(backfill.rows).toEqual([{ organization_id: INTERNAL, monthly_cost: '75' }]);
  } finally {
    clientSpy.mockRestore();
    querySpy.mockRestore();
    await pg.query('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  }
}, 30000);
