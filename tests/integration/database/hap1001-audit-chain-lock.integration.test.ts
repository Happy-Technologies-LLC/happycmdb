// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** HAP-1001 S1-T3, hosted real Timescale/Postgres: a held chain lock bounds logAudit to 55P03 (never an unbounded wait),
 * then v2 rows (µs UTC timestamp, canonical inet text) commit and verify. A private schema keeps this chain apart from
 * other suites' audit rows; the advisory lock is the shared hashtext('global') one. */
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { AUDIT_CHAIN_LOCK_TIMEOUT_MS, AuditService } from '../../../packages/database/src/postgres/audit.service';

const A = '11111111-1111-4111-8111-111111111111';
process.env['AUDIT_CHAIN_KEY'] = randomBytes(32).toString('hex');
let pool: Pool;
const entry = (ip?: string) => ({ entity_type: 'CI' as const, entity_id: 'hap1001-ci', action: 'UPDATE' as const,
  actor: 'hap1001-actor', actor_type: 'user' as const, changes: [{ field: 'name', old_value: 'a', new_value: 'b' }],
  ...(ip ? { ip_address: ip } : {}), user_agent: 'jest' });

beforeAll(async () => {
  pool = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
    database: process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'],
    options: '-c search_path=hap1001,public' });
  await pool.query(`DROP SCHEMA IF EXISTS hap1001 CASCADE; CREATE SCHEMA hap1001;
    CREATE TABLE hap1001.audit_log (LIKE public.audit_log INCLUDING DEFAULTS)`);
});
afterAll(async () => { await pool?.query('DROP SCHEMA IF EXISTS hap1001 CASCADE'); await pool?.end(); });

it('S1-T3: a held chain lock bounds logAudit to 55P03 within 3x the lock timeout; then v2 rows commit and verify', async () => {
  const service = new AuditService(pool);
  const holder = await pool.connect();
  await holder.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('global'))");
  // Real time on purpose: the bound under test is Postgres' own lock_timeout clock; the timer only catches an unbounded wait.
  const unbounded = Promise.withResolvers<string>();
  const timer = setTimeout(unbounded.resolve, 3 * AUDIT_CHAIN_LOCK_TIMEOUT_MS, 'unbounded');
  const outcome = await Promise.race([service.logAudit(entry(), A).then(() => 'committed', error => error.code), unbounded.promise]);
  clearTimeout(timer);
  await holder.query('ROLLBACK');
  holder.release();
  expect(outcome).toBe('55P03');
  await service.logAudit(entry('192.0.2.7'), A);
  await service.logAudit(entry(), A);
  expect(await service.verifyAuditChain()).toMatchObject({ ok: true, checked: 2, orgBindingViolations: [] });
});
