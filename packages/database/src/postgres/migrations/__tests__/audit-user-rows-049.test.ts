// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1713: the real appendAuditEntry / AuditService.logAudit / verifyAuditChain against the repo's real migrations on
 * PGlite (real PostgreSQL; only the transport is an IPC hop to the forked host). USER audit rows, the first rows that
 * carry ip_address, commit, canonicalise the address, chain across mixed entity types and verify; without migration 049
 * the same insert is a Postgres error. recent_audit_activity (001) does not expose the address.
 * Order matters: the pre-049 cases run first, then 049 is applied to the same database.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool, PoolClient } from 'pg';
import { logger } from '@cmdb/common';
import { AuditService, appendAuditEntry } from '../../audit.service';

const host = fork(join(__dirname, '../../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [],
  { serialization: 'advanced' });
let serial = 0;
type Result = { rows: Record<string, any>[]; rowCount: number };
const pending = new Map<number, PromiseWithResolvers<Result>>();
host.on('message', ({ id, rows, rowCount, error, code }: { id: number; rows: Record<string, any>[]; rowCount?: number;
  error?: string; code?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(Object.assign(new Error(error), { code }));
  else call.resolve({ rows, rowCount: rowCount || rows.length });
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query'): Promise<Result> {
  const id = serial++;
  const call = Promise.withResolvers<Result>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}
const rows = async (text: string, params: unknown[] = []) => (await sql(text, params)).rows;
// One PGlite session serves every statement; the service only needs pool.connect()/query().
const client = { query: (text: string, params?: unknown[]) => sql(text, params), release: () => undefined } as unknown as PoolClient;
const pool = { connect: async () => client, query: (text: string, params?: unknown[]) => sql(text, params) } as unknown as Pool;
const audit = new AuditService(pool);

const migrations = join(__dirname, '..');
const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
const migration = (file: string) => readFileSync(join(migrations, file), 'utf8');
const ORG_USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ORG_CI = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const [alice, bob, carol] = [randomUUID(), randomUUID(), randomUUID()];
const ciId = randomUUID();
const passwordChange = (user: string, ip?: string) => ({
  entity_type: 'USER' as const, entity_id: user, action: 'UPDATE' as const, actor: user, actor_type: 'user' as const,
  changes: [], metadata: { operation: 'password_change', outcome: 'success' }, ip_address: ip,
});
const stored = () => rows(`SELECT entity_type::text AS entity_type, entity_id, organization_id::text AS organization_id,
  host(ip_address) AS ip_address, masklen(ip_address) AS masklen, metadata, prev_hash, entry_hash FROM audit_log ORDER BY timestamp, id`);

beforeAll(async () => {
  process.env['AUDIT_CHAIN_KEY'] = randomBytes(32).toString('hex');
  const table = schema.match(/CREATE TABLE IF NOT EXISTS audit_log \([\s\S]*?\n\);/)![0];
  // 028 also alters these reconciliation tables; only its audit_log.organization_id column matters here.
  const stubs = ['ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules', 'source_authority',
    'ci_change_history', 'cmdb.dim_ci'].map(name => schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0]);
  await sql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, table, ...stubs].join('\n'),
    [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql']) {
    await sql(migration(file), [], 'exec');
  }
  await sql(schema.match(/CREATE OR REPLACE VIEW recent_audit_activity AS[\s\S]*?;/)![0], [], 'exec');
}, 60000);
afterAll(() => { host.kill(); });

it('without migration 049 a USER row is a Postgres enum error that appends nothing, while a CI row on the same schema commits', async () => {
  const errors = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  await audit.logAudit({ entity_type: 'CI', entity_id: ciId, action: 'CREATE', actor: 'actor-c', actor_type: 'user', changes: [] }, ORG_CI);
  await expect(audit.logAudit(passwordChange(alice, '203.0.113.7'), ORG_USER))
    .rejects.toMatchObject({ code: '22P02', message: expect.stringContaining('audit_entity_type') });
  expect(errors).toHaveBeenCalledTimes(1);
  errors.mockRestore();
  expect((await stored()).map(row => [row['entity_type'], row['entity_id']])).toEqual([['CI', ciId]]);
});

describe('with migration 049', () => {
  beforeAll(async () => { await sql(`BEGIN;\n${migration('049_audit_entity_user.sql')}\nCOMMIT;`, [], 'exec'); }, 30000);

  it('commits IPv4, IPv6 and address-less USER rows interleaved with a CI row: canonical host address, actor org, one chain', async () => {
    await audit.logAudit(passwordChange(alice, '203.0.113.7'), ORG_USER);
    await audit.logAudit({ entity_type: 'CI', entity_id: ciId, action: 'UPDATE', actor: 'actor-c', actor_type: 'user', changes: [] }, ORG_CI);
    // Uppercase, uncompressed IPv6: Postgres stores (and the chain hashes) the canonical host address.
    await audit.logAudit(passwordChange(bob, '2001:DB8:0:0:0:0:0:1'), ORG_USER);
    // appendAuditEntry on a caller-owned transaction, as the journal T2 and the auth repository use it.
    await client.query('BEGIN');
    await appendAuditEntry(client, passwordChange(carol), ORG_USER);
    await client.query('COMMIT');

    const all = await stored();
    expect(all.map(row => [row['entity_type'], row['entity_id'], row['organization_id'], row['ip_address']])).toEqual([
      ['CI', ciId, ORG_CI, null],
      ['USER', alice, ORG_USER, '203.0.113.7'],
      ['CI', ciId, ORG_CI, null],
      ['USER', bob, ORG_USER, '2001:db8::1'],
      ['USER', carol, ORG_USER, null],
    ]);
    expect(all.map(row => row['masklen'])).toEqual([null, 32, null, 128, null]);
    expect(all.map(row => row['metadata']['organization_id'])).toEqual([ORG_CI, ORG_USER, ORG_CI, ORG_USER, ORG_USER]);
    expect(all.map(row => row['prev_hash'])).toEqual([null, ...all.slice(0, -1).map(row => row['entry_hash'])]);
    expect(new Set(all.map(row => row['entry_hash'])).size).toBe(all.length);
  });

  it('verifyAuditChain accepts the mixed USER/CI chain with no org-binding violation', async () => {
    expect(await audit.verifyAuditChain()).toMatchObject({ ok: true, checked: 5, orgBindingViolations: [] });
  });

  it('verifyAuditChain flags a USER row whose address was altered after the write (the address is chained)', async () => {
    await sql(`UPDATE audit_log SET ip_address = '198.51.100.9' WHERE entity_id = $1`, [alice]);
    expect(await audit.verifyAuditChain()).toMatchObject({ ok: false });
    await sql(`UPDATE audit_log SET ip_address = '203.0.113.7' WHERE entity_id = $1`, [alice]);
    expect(await audit.verifyAuditChain()).toMatchObject({ ok: true, checked: 5 });
  });

  it('recent_audit_activity lists the USER row by entity id only: no address, user agent, metadata or changes', async () => {
    const [row, ...extra] = await rows(`SELECT * FROM recent_audit_activity WHERE entity_type = 'USER' AND entity_id = $1`, [alice]);
    expect(extra).toEqual([]);
    expect(row).toMatchObject({ entity_id: alice, action: 'UPDATE', actor: alice });
    for (const column of ['ip_address', 'user_agent', 'metadata', 'changes']) expect(row).not.toHaveProperty(column);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
    // The address is in the table: the view's silence is its column list, not an absent value.
    expect(await rows('SELECT host(ip_address) AS ip FROM audit_log WHERE entity_id = $1', [alice])).toEqual([{ ip: '203.0.113.7' }]);
  });
});
