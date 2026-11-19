// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2126 L1a: deploy/build01-staging-app-login.sql re-applies 045 when it is recorded, but 046, 047, 048, 054 and 056 grant their
// own tables to cmdb_app and the migrator never re-runs a recorded migration, so a dropped and re-created cmdb_app lacked
// those grants (relationship writes then failed in T2 with 42501). The script's `$hap2126$` block restores exactly them.
//
// The block runs on PGlite against the real 046, 047, 048, 054 and 056 files. The whole ordered migration set cannot run on PGlite
// (001 needs TimescaleDB), so the whole-grant matrix test builds each database from stand-in tables for every relation that 045
// grants (read from 045 itself), then runs 045 to 048, 054 and 056 verbatim. The same matrix is proven on a real server, over the
// full migration set, by the "role re-creation" step of deploy/test-staging-migrations.sh (hosted CI job `staging-migrations`).
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const HOST = join(__dirname, '../../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs');
const children: Array<ReturnType<typeof fork>> = [];
/** A fresh in-memory PostgreSQL; roles are cluster-wide, so each scenario needs its own. */
function open(): (sql: string) => Promise<Array<Record<string, any>>> {
  const host = fork(HOST, [], { serialization: 'advanced' });
  children.push(host);
  let serial = 0;
  const pending = new Map<number, { resolve: (rows: Array<Record<string, any>>) => void; reject: (error: Error) => void }>();
  host.on('message', ({ id, rows, error }: { id: number; rows: Array<Record<string, any>>; error?: string }) => {
    const reply = pending.get(id)!;
    pending.delete(id);
    if (error) reply.reject(new Error(error));
    else reply.resolve(rows);
  });
  return sql => {
    const id = serial++;
    const { promise, resolve, reject } = Promise.withResolvers<Array<Record<string, any>>>();
    pending.set(id, { resolve, reject });
    host.send({ id, op: /^\s*SELECT/i.test(sql) ? 'query' : 'exec', sql, params: [] });
    return promise;
  };
}
afterAll(() => { children.forEach(child => child.kill()); });

const MIGRATIONS = join(__dirname, '..');
const migration = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
const APP_LOGIN_SCRIPT = readFileSync(join(__dirname, '../../../../../../deploy/build01-staging-app-login.sql'), 'utf8');
const TABLE_MIGRATIONS = ['046_service_offerings.sql', '047_ai_sync_cursors.sql', '048_portfolio_import.sql',
  '054_relationship_evidence_receipts.sql', '056_estate_kpi_snapshots.sql'];

/** The `$hap2126$` DO block of the script, exactly as psql would send it. */
function grantBlock(): string {
  const block = /DO \$hap2126\$[\s\S]*?\$hap2126\$;/.exec(APP_LOGIN_SCRIPT);
  if (!block) throw new Error('deploy/build01-staging-app-login.sql has no $hap2126$ DO block: the per-table cmdb_app re-grant is missing');
  return block[0];
}

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
/** What the migrations 046, 047, 048, 054 and 056 give the app logins, table by table (never UPDATE on an append-only table). */
const EXPECTED: Record<string, string[]> = {
  'public.service_offerings': ['SELECT', 'INSERT', 'UPDATE'],
  'public.ai_sync_cursors': ['SELECT', 'INSERT', 'UPDATE'],
  'public.portfolio_imports': ['SELECT', 'INSERT'],
  'public.portfolio_import_map': ['SELECT', 'INSERT'],
  'public.relationship_evidence_receipts': ['SELECT', 'INSERT'],
  'public.estate_kpi_snapshots': ['SELECT', 'INSERT'],
};

/**
 * 046 and 048 need the business-service table and the audit enum of 001 (with 008 and 043 on top), as service-offerings-046.test.ts
 * builds them; 047, 054 and 056 stand alone. `app` creates cmdb_app first (a fresh staging install) or not (it is re-created later).
 */
async function prepare(query: (sql: string) => Promise<Array<Record<string, any>>>, app: boolean, extra = ''): Promise<void> {
  const schema = migration('001_complete_schema.sql');
  await query(`CREATE ROLE cmdb_user LOGIN; ${app ? 'CREATE ROLE cmdb_app LOGIN NOSUPERUSER;' : ''} CREATE SCHEMA cmdb;
    ${schema.match(/CREATE TYPE audit_entity_type AS ENUM \([^;]*\);/)![0]}
    ${schema.match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/)![0]}
    ${extra}`);
  for (const name of ['008_business_service_organization_scope.sql', '043_business_service_record_c1.sql']) {
    await query(`BEGIN;\n${migration(name)}\nCOMMIT;`);
  }
}
const migrate = (query: (sql: string) => Promise<Array<Record<string, any>>>, name: string) =>
  query(`BEGIN;\n${migration(name)}\nCOMMIT;`);

const held = async (query: (sql: string) => Promise<Array<Record<string, any>>>, role: string, table: string) =>
  (await query(`SELECT ${PRIVILEGES.map(p => `has_table_privilege('${role}', '${table}', '${p}') AS "${p}"`).join(', ')}`))
    .flatMap(row => PRIVILEGES.filter(p => row[p] === true));

describe('the $hap2126$ block in the app-login script', () => {
  it('restores exactly the migrations\' grants on a re-created cmdb_app, never more, and re-runs cleanly', async () => {
    const query = open();
    await prepare(query, false);
    for (const name of TABLE_MIGRATIONS) await migrate(query, name); // no cmdb_app yet: every migration grant to it is skipped
    await query('CREATE ROLE cmdb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
    for (const table of Object.keys(EXPECTED)) expect([table, await held(query, 'cmdb_app', table)]).toEqual([table, []]);
    const userBefore = await grantMatrix(query, 'cmdb_user');
    await query(grantBlock());
    const after = async () => Object.fromEntries(await Promise.all(Object.keys(EXPECTED).map(async table =>
      [table, await held(query, 'cmdb_app', table)] as const)));
    expect(await after()).toEqual(EXPECTED);
    await query(grantBlock());
    expect(await after()).toEqual(EXPECTED);
    expect(await grantMatrix(query, 'cmdb_user')).toEqual(userBefore); // cmdb_user's grants are not touched
  }, 60000);

  it('does nothing for a table that is not migrated yet and still applies the other rows', async () => {
    const query = open();
    await prepare(query, false);
    for (const name of TABLE_MIGRATIONS) await migrate(query, name);
    await query('CREATE ROLE cmdb_app LOGIN');
    await query('ALTER TABLE public.portfolio_imports RENAME TO portfolio_imports_away');
    await query(grantBlock());
    expect(await held(query, 'cmdb_app', 'public.portfolio_imports_away')).toEqual([]);
    expect(await held(query, 'cmdb_app', 'public.relationship_evidence_receipts')).toEqual(['SELECT', 'INSERT']);
    expect(await held(query, 'cmdb_app', 'public.estate_kpi_snapshots')).toEqual(['SELECT', 'INSERT']);
    expect(await held(query, 'cmdb_app', 'public.service_offerings')).toEqual(['SELECT', 'INSERT', 'UPDATE']);
  }, 60000);
});

/** Every privilege of `role` on every relation, schema and function of public and cmdb, as sorted `object|privilege|t/f` rows. */
async function grantMatrix(query: (sql: string) => Promise<Array<Record<string, any>>>, role: string): Promise<string[]> {
  const rows = await query(`
    SELECT n.nspname || '.' || c.relname || '|' || p.privilege || '|'
        || CASE WHEN CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('${role}', c.oid, p.privilege)
                     ELSE has_table_privilege('${role}', c.oid, p.privilege) END THEN 't' ELSE 'f' END AS row
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
        ELSE ARRAY['${PRIVILEGES.join("', '")}'] END) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    UNION ALL
    SELECT 'schema ' || n.nspname || '|' || p.privilege || '|'
        || CASE WHEN has_schema_privilege('${role}', n.oid, p.privilege) THEN 't' ELSE 'f' END
      FROM pg_namespace n CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS p(privilege) WHERE n.nspname IN ('public', 'cmdb')
    UNION ALL
    SELECT 'function ' || f.oid::regprocedure::text || '|EXECUTE|'
        || CASE WHEN has_function_privilege('${role}', f.oid, 'EXECUTE') THEN 't' ELSE 'f' END
      FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname IN ('public', 'cmdb')`);
  return rows.map(row => row['row'] as string).sort();
}

describe('whole-grant matrix: a re-created cmdb_app equals a freshly migrated one', () => {
  /** Stand-in tables for every relation 045 grants (it refuses to run when one is missing), plus the ordered migrations. */
  const standIns = () => {
    const tables = [...migration('045_staging_app_login_acl.sql').matchAll(/\('((?:public|cmdb)\.[a-z_]+)',\s*'[A-Z, ]+'\)/g)]
      .map(match => match[1]!).filter(table => table !== 'public.dim_business_services'); // the real one comes from prepare()
    expect(tables.length).toBeGreaterThan(40);
    return tables.map(table => `CREATE TABLE ${table} (id serial PRIMARY KEY);`).join('\n');
  };

  it('has an empty difference, over a matrix that carries the six per-table grants', async () => {
    const [baseline, recreated] = [open(), open()];
    // Baseline, as a fresh staging install: app-login creates cmdb_app before the migrator, which then runs 045 to 056 in order.
    await prepare(baseline, true, standIns());
    for (const name of ['045_staging_app_login_acl.sql', ...TABLE_MIGRATIONS]) await migrate(baseline, name);
    // Re-creation: the migrations ran without cmdb_app, then app-login created it and re-applied 045 and the block.
    await prepare(recreated, false, standIns());
    for (const name of TABLE_MIGRATIONS) await migrate(recreated, name);
    await recreated('CREATE ROLE cmdb_app LOGIN NOSUPERUSER');
    await migrate(recreated, '045_staging_app_login_acl.sql');
    await recreated(grantBlock());

    const [fresh, again] = [await grantMatrix(baseline, 'cmdb_app'), await grantMatrix(recreated, 'cmdb_app')];
    for (const [table, privileges] of Object.entries(EXPECTED)) {
      for (const privilege of PRIVILEGES) expect(fresh).toContain(`${table}|${privilege}|${privileges.includes(privilege) ? 't' : 'f'}`);
    }
    expect(fresh.length).toBeGreaterThan(300);
    expect({ onlyInFresh: fresh.filter(row => !again.includes(row)), onlyInRecreated: again.filter(row => !fresh.includes(row)) })
      .toEqual({ onlyInFresh: [], onlyInRecreated: [] });
    expect(again).toEqual(fresh);
  }, 120000);
});
