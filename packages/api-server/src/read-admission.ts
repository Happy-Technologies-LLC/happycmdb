// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { Pool } from 'pg';
import { ADMISSION_LOCK_KEY, getNeo4jClient, getPostgresClient, JournalUnavailableError } from '@cmdb/database';

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
/** AP-P': hold the organization admission lock shared through the CI-referencing write. */
export async function writeReferencedCIs<T>(
  organizationId: string, ciIds: string[], write: (client: import('pg').PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPostgresClient().pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      // Shared, so it queues behind a waiting T1 instead of overtaking it (F8').
      await client.query(`SELECT pg_advisory_xact_lock_shared(${ADMISSION_LOCK_KEY})`, [organizationId]);
      const gap = await client.query(
        `SELECT 1 FROM ci_reconciliation_operations
         WHERE organization_id=$1 AND ci_id=ANY($2::text[]) AND state IN ('pending','failed') LIMIT 1`,
        [organizationId, ciIds]);
      if (gap.rows.length) throw new CIGapError();
      const result = await write(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // A failed ROLLBACK destroys the connection: never pool it in a transaction still holding the lock.
      await client.query('ROLLBACK').catch((rollbackError: Error) => { broken = rollbackError; });
      // v16 §5.3: lock_timeout on the admission lock is a 503, never a 500.
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw new JournalUnavailableError();
      throw error;
    }
  } finally {
    client.release(broken);
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
  rows: T[], timeoutMs?: number
): Promise<T[]> {
  const validOrg = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const omitted = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const pairs = rows.slice(offset, offset + 1000).filter(row =>
      typeof row.id === 'string' && typeof row.organization_id === 'string' &&
      validOrg.test(row.organization_id));
    if (!pairs.length) continue;
    const text = `SELECT organization_id, ci_id FROM ci_reconciliation_operations
       WHERE (organization_id, ci_id) IN
         (SELECT * FROM unnest($1::uuid[], $2::text[]))
         AND state IN ('pending','failed')`;
    const values = [pairs.map(row => row.organization_id), pairs.map(row => row.id)];
    const timedQuery = { text, values, query_timeout: timeoutMs };
    const result = timeoutMs === undefined
      ? await getPostgresClient().query(text, values)
      : await getPostgresClient().pool.query(timedQuery);
    for (const row of result.rows) omitted.add(`${row.organization_id.toLowerCase()}:${row.ci_id}`);
  }
  return rows.filter(row => typeof row.organization_id !== 'string' ||
    !omitted.has(`${row.organization_id.toLowerCase()}:${row.id}`));
}

/** Fill a global page without an unbounded gap scan or a partial success on exhaustion. */
export async function readGlobalCIPage<T extends { id?: unknown; organization_id?: unknown }>(
  page: (offset: number, timeoutMs: number) => Promise<T[]>
): Promise<T[]> {
  const result: T[] = [];
  const expiresAt = Date.now() + 10_000;
  const remaining = () => {
    const milliseconds = expiresAt - Date.now();
    if (milliseconds <= 0) throw new CIListUnavailableError();
    return milliseconds;
  };
  for (let batch = 0; batch < 20; batch++) {
    const candidates = await page(batch * 100, remaining());
    remaining();
    try {
      result.push(...(await filterGlobalCIGaps(candidates, remaining())).slice(0, 101 - result.length));
    } catch (error) {
      if (Date.now() >= expiresAt) throw new CIListUnavailableError();
      throw error;
    }
    remaining();
    // A full accepted page is not proof of completeness: look ahead for the 101st.
    if (result.length > 100) throw new CIListUnavailableError();
    if (candidates.length < 100) return result;
  }
  throw new CIListUnavailableError();
}

const MAX_PENDING_CI_IDS = 1000;
interface Snapshot { epoch: string; pending: string[] }
/** The read fence is the epoch every T1 bumps plus pending/failed membership. */
function samePending(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  if (first.length === 0) return true;
  const left = new Set(first);
  return left.size === new Set(second).size && second.every(ciId => left.has(ciId));
}
async function snapshot(organizationId: string, timeoutMs: number): Promise<Snapshot> {
  try {
    const timedSnapshot = {
      text: `SELECT COALESCE((SELECT epoch FROM ci_reconciliation_epochs WHERE organization_id=$1), 0)::text AS epoch,
             ARRAY(SELECT ci_id FROM ci_reconciliation_operations
                   WHERE organization_id=$1 AND state IN ('pending','failed')
                   LIMIT $2) AS pending`,
      values: [organizationId, MAX_PENDING_CI_IDS + 1], query_timeout: timeoutMs,
    };
    const result = await getPostgresClient().pool.query(timedSnapshot);
    const row = result.rows[0] as Snapshot;
    if (!row || row.pending.length > MAX_PENDING_CI_IDS) throw new CIListUnavailableError();
    return row;
  } catch {
    throw new CIListUnavailableError();
  }
}

let admissionPool: Pool | undefined;
const activeByOrg = new Map<string, number>();
function isolatedPool(): Pool {
  if (!admissionPool) {
    // pg-pool hides `password` from enumeration, so a bare spread would connect without it.
    const { options } = getPostgresClient().pool;
    admissionPool = new Pool({ ...options, password: options.password, max: 4, connectionTimeoutMillis: 250,
      options: '-c statement_timeout=12000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000' });
  }
  return admissionPool;
}

/** Never holds the shared PG pool across a graph call. Exactly one isolated fallback. */
export async function readCIList<T>(
  organizationId: string, read: (pending: string[], timeoutMs: number) => Promise<T>
): Promise<T> {
  const expiresAt = Date.now() + 10_000;
  const remaining = () => {
    const milliseconds = expiresAt - Date.now();
    if (milliseconds <= 0) throw new CIListUnavailableError();
    return milliseconds;
  };
  const first = await snapshot(organizationId, remaining());
  remaining();
  const optimistic = await read(first.pending, remaining());
  const second = await snapshot(organizationId, remaining());
  remaining();
  if (BigInt(second.epoch) === BigInt(first.epoch) &&
    samePending(first.pending, second.pending)) return optimistic;

  const active = activeByOrg.get(organizationId) ?? 0;
  if (active >= 2) throw new CIListUnavailableError();
  activeByOrg.set(organizationId, active + 1);
  try {
    const client = await isolatedPool().connect();
    let broken: Error | undefined;
    try {
      const timedQuery = (text: string, values?: (string | number)[]) =>
        ({ text, values, query_timeout: remaining() });
      remaining();
      await client.query(timedQuery('BEGIN'));
      try {
        await client.query(timedQuery(`SELECT pg_advisory_xact_lock_shared(${ADMISSION_LOCK_KEY})`, [organizationId]));
        const pending = await client.query<{ ci_id: string }>(timedQuery(
          `SELECT ci_id FROM ci_reconciliation_operations
           WHERE organization_id=$1 AND state IN ('pending','failed') LIMIT $2`,
          [organizationId, MAX_PENDING_CI_IDS + 1]));
        if (pending.rows.length > MAX_PENDING_CI_IDS) throw new CIListUnavailableError();
        const pendingIds = pending.rows.map(row => row.ci_id);
        const result = await read(pendingIds, remaining());
        const latest = await client.query<{ ci_id: string }>(timedQuery(
          `SELECT ci_id FROM ci_reconciliation_operations
           WHERE organization_id=$1 AND state IN ('pending','failed') LIMIT $2`,
          [organizationId, MAX_PENDING_CI_IDS + 1]));
        if (latest.rows.length > MAX_PENDING_CI_IDS ||
          !samePending(pendingIds, latest.rows.map(row => row.ci_id))) throw new CIListUnavailableError();
        remaining();
        await client.query(timedQuery('COMMIT'));
        return result;
      } catch (error) {
        const rollback = { text: 'ROLLBACK', query_timeout: Math.max(1, expiresAt - Date.now()) };
        await client.query(rollback).catch((rollbackError: Error) => { broken = rollbackError; });
        throw error;
      }
    } finally {
      client.release(broken);
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
