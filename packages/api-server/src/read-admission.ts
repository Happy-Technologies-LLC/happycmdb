// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { Pool } from 'pg';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';

export class CIGapError extends Error {
  constructor() { super('CI is temporarily unavailable'); }
}
export class CIListUnavailableError extends Error {
  constructor() { super('CI list temporarily unavailable'); }
}

export const CI_GAP_RESPONSE = {
  success: false, error: 'Conflict', message: 'CI is temporarily unavailable',
} as const;
export const CI_LIST_UNAVAILABLE_RESPONSE = {
  success: false, error: 'Service Unavailable', message: 'CI list temporarily unavailable',
} as const;

export async function assertNoCIGap(organizationId: string, ciId: string): Promise<void> {
  const result = await getPostgresClient().query(
    `SELECT 1 FROM ci_reconciliation_operations
     WHERE organization_id = $1 AND ci_id = $2 AND state IN ('pending', 'failed') LIMIT 1`,
    [organizationId, ciId]
  );
  if (result.rows.length > 0) throw new CIGapError();
}

/** Pre/post check discards a read that races an own-organization T1 commit. */
export async function readSingleCI<T>(organizationId: string, ciId: string, read: () => Promise<T>): Promise<T> {
  await assertNoCIGap(organizationId, ciId);
  const result = await read();
  await assertNoCIGap(organizationId, ciId);
  return result;
}
/** AP-P': hold the organization epoch share lock through the CI-referencing write. */
export async function writeReferencedCIs<T>(
  organizationId: string, ciIds: string[], write: (client: import('pg').PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPostgresClient().pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`INSERT INTO ci_reconciliation_epochs (organization_id, epoch)
                          VALUES ($1, 0) ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
      await client.query(`SELECT epoch FROM ci_reconciliation_epochs WHERE organization_id=$1 FOR SHARE`,
        [organizationId]);
      const gap = await client.query(
        `SELECT 1 FROM ci_reconciliation_operations
         WHERE organization_id=$1 AND ci_id=ANY($2::text[]) AND state IN ('pending','failed') LIMIT 1`,
        [organizationId, ciIds]);
      if (gap.rows.length) throw new CIGapError();
      const result = await write(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
/** AP-D': the dimension row alone is not proof that the current graph node is owned. */
export async function filterOwnedDimensionRows<T extends { ci_id: string }>(
  organizationId: string, rows: T[]
): Promise<T[]> {
  if (!rows.length) return rows;
  const owned = new Set<string>();
  const session = getNeo4jClient().getSession();
  try {
    for (let offset = 0; offset < rows.length; offset += 1000) {
      const ids = [...new Set(rows.slice(offset, offset + 1000).map(row => row.ci_id))];
      const result = await session.run(
        `MATCH (ci:CI) WHERE ci.id IN $ids AND ci.organization_id = $organizationId
         RETURN ci.id AS id`,
        { ids, organizationId }, { timeout: 10_000 });
      for (const record of result.records) owned.add(record.get('id'));
    }
  } finally {
    await session.close();
  }
  return rows.filter(row => owned.has(row.ci_id));
}
/** AP-R: omit pending/failed rows after a platform-wide graph read. */
export async function filterGlobalCIGaps<T extends { id?: unknown; organization_id?: unknown }>(
  rows: T[]
): Promise<T[]> {
  const validOrg = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const omitted = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const pairs = rows.slice(offset, offset + 1000).filter(row =>
      typeof row.id === 'string' && typeof row.organization_id === 'string' &&
      validOrg.test(row.organization_id));
    if (!pairs.length) continue;
    const result = await getPostgresClient().query(
      `SELECT organization_id, ci_id FROM ci_reconciliation_operations
       WHERE (organization_id, ci_id) IN
         (SELECT * FROM unnest($1::uuid[], $2::text[]))
         AND state IN ('pending','failed')`,
      [pairs.map(row => row.organization_id), pairs.map(row => row.id)]
    );
    for (const row of result.rows) omitted.add(`${row.organization_id.toLowerCase()}:${row.ci_id}`);
  }
  return rows.filter(row => typeof row.organization_id !== 'string' ||
    !omitted.has(`${row.organization_id.toLowerCase()}:${row.id}`));
}

interface Snapshot { epoch: string; pending: string[] }
async function snapshot(organizationId: string): Promise<Snapshot> {
  const result = await getPostgresClient().query(
    `SELECT COALESCE((SELECT epoch FROM ci_reconciliation_epochs WHERE organization_id=$1), 0)::text AS epoch,
            ARRAY(SELECT ci_id FROM ci_reconciliation_operations
                  WHERE organization_id=$1 AND state IN ('pending','failed')) AS pending`,
    [organizationId]
  );
  return result.rows[0] as Snapshot;
}

let admissionPool: Pool | undefined;
const activeByOrg = new Map<string, number>();
function isolatedPool(): Pool {
  if (!admissionPool) {
    admissionPool = new Pool({ ...getPostgresClient().pool.options,
      max: 4, connectionTimeoutMillis: 250,
      options: '-c statement_timeout=12000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000' });
  }
  return admissionPool;
}

/** Never holds the shared PG pool across a graph call. Exactly one isolated fallback. */
export async function readCIList<T>(
  organizationId: string, read: (pending: string[], timeoutMs: number) => Promise<T>
): Promise<T> {
  const first = await snapshot(organizationId);
  const optimistic = await read(first.pending, 10_000);
  const second = await snapshot(organizationId);
  if (BigInt(second.epoch) === BigInt(first.epoch)) return optimistic;

  const active = activeByOrg.get(organizationId) ?? 0;
  if (active >= 2) throw new CIListUnavailableError();
  activeByOrg.set(organizationId, active + 1);
  try {
    const client = await isolatedPool().connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO ci_reconciliation_epochs (organization_id, epoch)
                            VALUES ($1, 0) ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
        await client.query('SELECT epoch FROM ci_reconciliation_epochs WHERE organization_id=$1 FOR SHARE', [organizationId]);
        const pending = await client.query<{ ci_id: string }>(
          `SELECT ci_id FROM ci_reconciliation_operations
           WHERE organization_id=$1 AND state IN ('pending','failed')`, [organizationId]);
        const result = await read(pending.rows.map(row => row.ci_id), 10_000);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof CIGapError) throw error;
    throw new CIListUnavailableError();
  } finally {
    const current = activeByOrg.get(organizationId)!;
    if (current === 1) activeByOrg.delete(organizationId);
    else activeByOrg.set(organizationId, current - 1);
  }
}
