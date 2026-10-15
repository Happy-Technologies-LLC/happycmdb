// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { Pool } from 'pg';
import { getPostgresClient } from '@cmdb/database';

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
    if (active === 0) activeByOrg.delete(organizationId);
    else activeByOrg.set(organizationId, active);
  }
}
