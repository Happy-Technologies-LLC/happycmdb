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
import { fork, spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOST = join(__dirname, '../../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs');
/** The same host with the uuid-ossp extension available (migration 001 creates it). */
const UUID_HOST = join(__dirname, 'fixtures/pglite-uuid-host.cjs');
const children: Array<ReturnType<typeof fork>> = [];
/** A fresh in-memory PostgreSQL; roles are cluster-wide, so each scenario needs its own. */
function open(hostFile = HOST): (sql: string) => Promise<Array<Record<string, any>>> {
  const host = fork(hostFile, [], { serialization: 'advanced' });
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

const TAG = '$hap2126$';
/**
 * The `$hap2126$` DO block of `script`, cut the way the PostgreSQL lexer cuts it: the dollar-quoted body ends at the FIRST `$hap2126$`
 * after the opener, a `--` comment or a string included (plpgsql comments are invisible to the SQL lexer), and the statement ends with the
 * `;` right after it. A first tag followed by anything else (a space, another token) is refused.
 */
function blockOfScript(script: string): string {
  const open = script.indexOf(`DO ${TAG}`);
  if (open < 0) throw new Error('deploy/build01-staging-app-login.sql has no $hap2126$ DO block: the per-table cmdb_app re-grant is missing');
  const close = script.indexOf(TAG, open + `DO ${TAG}`.length);
  if (close < 0 || script[close + TAG.length] !== ';') {
    throw new Error('the first $hap2126$ after the DO block opener is not followed by `;`: PostgreSQL ends the block there, so the text after it is not part of the block');
  }
  return script.slice(open, close + TAG.length + 1);
}
/** A script must hold the tag exactly twice (opener and closer), in code or comment: a third one is a lexer-visible block end the text checks cannot see. */
const tagCountProblem = (script: string): string | undefined => {
  const count = script.split(TAG).length - 1;
  return count === 2 ? undefined : `deploy/build01-staging-app-login.sql holds ${count} $hap2126$ tags, not the two of the DO block's opener and closer`;
};
function grantBlockOf(script: string): string {
  const problem = tagCountProblem(script);
  if (problem) throw new Error(problem);
  return blockOfScript(script);
}
/** The $hap2126$ DO block of the real script, exactly as psql would send it. */
const grantBlock = (): string => grantBlockOf(APP_LOGIN_SCRIPT);

/**
 * The block with a WITH GRANT OPTION built in the FOR projection: the EXECUTE stays byte-identical to the canonical statement, and the
 * grant keyword is split so no GRANT token and no `|| ' WITH GRANT OPTION'` appears in it. `--` comments out the rest of the
 * format() string's `ON %s` tail; `split_part` lets the IF guard still see the bare table name.
 */
function withGrantOptionProjection(block: string): string {
  const from = "FOR g IN SELECT * FROM (VALUES";
  const guard = 'to_regclass(g.rel)';
  if (!block.includes(from) || !block.includes(guard)) throw new Error('the $hap2126$ block no longer has the FOR / IF lines the projection fixture rewrites');
  return block
    .replace(from, "FOR g IN SELECT t.rel || ' TO cmdb_app WITH GR' || 'ANT OPTION --' AS rel, t.privs FROM (VALUES")
    .replace(guard, "to_regclass(split_part(g.rel, ' ', 1))");
}

/**
 * The second review's bypass, one whole `--` line between the block's last statement and its closing tag. PostgreSQL's SQL lexer does not
 * know plpgsql comments, so the DO body ends at the comment's tag, the grant after it runs as a statement of its own, and the no-op DO
 * consumes the real closing tag. A text lint that drops whole `--` lines sees an ordinary block.
 */
const COMMENTED_TAG_GRANT = `    -- ${TAG} ; GRANT SELECT ON public.dim_business_services TO cmdb_app WITH GRANT OPTION; DO ${TAG} BEGIN END`;
function withCommentedTagGrant(script: string, line = COMMENTED_TAG_GRANT): string {
  const closing = script.lastIndexOf(`${TAG};`);
  const lineStart = script.lastIndexOf('\n', closing) + 1;
  if (closing < 0 || script.slice(lineStart, closing).trim() !== '') throw new Error('the $hap2126$ closing tag is no longer alone on its line: adjust the fixture');
  return `${script.slice(0, lineStart)}${line}\n${script.slice(lineStart)}`;
}
/** What psql sends to the server for the block: from its opener to the last tag of the script, as the server lexes it (any statement the comment turned into one included). */
const psqlSends = (script: string): string => script.slice(script.indexOf(`DO ${TAG}`), script.lastIndexOf(`${TAG};`) + TAG.length + 1);

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
/**
 * Every `<schema>.<relation>|<PRIVILEGE>` of every relation in public and cmdb on which `role` holds the privilege WITH GRANT OPTION (it
 * could re-grant it to any role), sorted. Not limited to the tables the block restores: a grant option on any other relation counts. The
 * relation and privilege sets are those of `grantMatrix`, which reports the same grant options as `g` rows (this sweep also covers 'f' relations).
 */
const grantOptionsSweep = async (query: (sql: string) => Promise<Array<Record<string, any>>>, role: string): Promise<string[]> =>
  (await query(`
    SELECT n.nspname || '.' || c.relname || '|' || p.privilege AS row
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
        ELSE ARRAY['${PRIVILEGES.join("', '")}'] END) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('${role}', c.oid, p.privilege || ' WITH GRANT OPTION')
                 ELSE has_table_privilege('${role}', c.oid, p.privilege || ' WITH GRANT OPTION') END`))
    .map(row => row['row'] as string).sort();
/** `EXPECTED` as the sorted `<table>|<PRIVILEGE>` rows `grantOptionsSweep` reports when every restored privilege is re-grantable. */
const EXPECTED_AS_GRANT_OPTIONS = Object.entries(EXPECTED).flatMap(([table, privileges]) => privileges.map(p => `${table}|${p}`)).sort();

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
    expect(await grantOptionsSweep(query, 'cmdb_app')).toEqual([]); // restored, but nothing in public or cmdb is re-grantable
    await query(grantBlock());
    expect(await after()).toEqual(EXPECTED);
    expect(await grantOptionsSweep(query, 'cmdb_app')).toEqual([]);
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
    expect(await grantOptionsSweep(query, 'cmdb_app')).toEqual([]);
  }, 60000);

  it('a block that builds WITH GRANT OPTION in its FOR projection leaves cmdb_app holding the grant option, and the check sees it', async () => {
    const query = open();
    await prepare(query, false);
    for (const name of TABLE_MIGRATIONS) await migrate(query, name);
    await query('CREATE ROLE cmdb_app LOGIN');
    await query(withGrantOptionProjection(grantBlock()));
    expect(await grantOptionsSweep(query, 'cmdb_app')).toEqual(EXPECTED_AS_GRANT_OPTIONS); // every restored privilege of every table is re-grantable, and nothing else
  }, 60000);

  it('a whole-line comment that holds the tag ends the block for PostgreSQL, so its GRANT ... WITH GRANT OPTION runs, and the sweep sees it on a table outside EXPECTED', async () => {
    const query = open();
    await prepare(query, false);
    for (const name of TABLE_MIGRATIONS) await migrate(query, name);
    await query('CREATE ROLE cmdb_app LOGIN');
    const script = withCommentedTagGrant(APP_LOGIN_SCRIPT);
    expect(script.split('\n').filter(line => /^\s*--/.test(line))).toContain(COMMENTED_TAG_GRANT); // to a text lint, and to a reader, a comment
    await query(psqlSends(script));
    expect(await held(query, 'cmdb_app', 'public.service_offerings')).toEqual(['SELECT', 'INSERT', 'UPDATE']); // the original block still ran
    expect(await grantOptionsSweep(query, 'cmdb_app')).toEqual(['public.dim_business_services|SELECT']);
  }, 60000);
});

/**
 * The query of `grantMatrix`. The same query runs against a real server in `grant_matrix()` of deploy/test-staging-migrations.sh with the
 * role literal `cmdb_app`; a test below compares the two texts, so an edit made to one copy only fails there.
 */
function grantMatrixSql(role: string): string {
  return `
    SELECT n.nspname || '.' || c.relname || '|' || p.privilege || '|'
        || CASE WHEN CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('${role}', c.oid, p.privilege || ' WITH GRANT OPTION')
                     ELSE has_table_privilege('${role}', c.oid, p.privilege || ' WITH GRANT OPTION') END THEN 'g'
                WHEN CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('${role}', c.oid, p.privilege)
                     ELSE has_table_privilege('${role}', c.oid, p.privilege) END THEN 't' ELSE 'f' END AS row
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
        ELSE ARRAY['${PRIVILEGES.join("', '")}'] END) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    UNION ALL
    SELECT 'schema ' || n.nspname || '|' || p.privilege || '|'
        || CASE WHEN has_schema_privilege('${role}', n.oid, p.privilege || ' WITH GRANT OPTION') THEN 'g'
                WHEN has_schema_privilege('${role}', n.oid, p.privilege) THEN 't' ELSE 'f' END
      FROM pg_namespace n CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS p(privilege) WHERE n.nspname IN ('public', 'cmdb')
    UNION ALL
    SELECT 'function ' || f.oid::regprocedure::text || '|EXECUTE|'
        || CASE WHEN has_function_privilege('${role}', f.oid, 'EXECUTE WITH GRANT OPTION') THEN 'g'
                WHEN has_function_privilege('${role}', f.oid, 'EXECUTE') THEN 't' ELSE 'f' END
      FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname IN ('public', 'cmdb')
        AND (NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = f.oid AND e.deptype = 'e')
             OR EXISTS (SELECT 1 FROM aclexplode(f.proacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = '${role}'))
    UNION ALL
    SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname || '|' || p.privilege || '|'
        || CASE WHEN has_column_privilege('${role}', a.attrelid, a.attnum, p.privilege || ' WITH GRANT OPTION') THEN 'g' ELSE 't' END
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
        AND ((has_column_privilege('${role}', a.attrelid, a.attnum, p.privilege)
              AND NOT has_table_privilege('${role}', a.attrelid, p.privilege))
             OR (has_column_privilege('${role}', a.attrelid, a.attnum, p.privilege || ' WITH GRANT OPTION')
                 AND NOT has_table_privilege('${role}', a.attrelid, p.privilege || ' WITH GRANT OPTION')))
    UNION ALL
    SELECT 'default_acl ' || r.rolname || ' ' || coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || '|'
        || coalesce(g.rolname, 'PUBLIC') || '|' || x.privilege_type || '|' || CASE WHEN x.is_grantable THEN 'g' ELSE 't' END
      FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) x LEFT JOIN pg_roles g ON g.oid = x.grantee
      WHERE r.rolname = '${role}' OR g.rolname = '${role}'
    UNION ALL
    SELECT 'database ' || current_database() || '|' || p.privilege || '|'
        || CASE WHEN has_database_privilege('${role}', current_database(), p.privilege || ' WITH GRANT OPTION') THEN 'g'
                WHEN has_database_privilege('${role}', current_database(), p.privilege) THEN 't' ELSE 'f' END
      FROM (VALUES ('CONNECT'), ('CREATE'), ('TEMP')) AS p(privilege)`;
}

/**
 * Every privilege of `role` on every relation, schema and function of public and cmdb, as sorted `object|privilege|g/t/f` rows (`g`:
 * held WITH GRANT OPTION, `t`: held without it, `f`: not held), plus the column-only privileges (`column <schema>.<table>.<column>|
 * <PRIVILEGE>|g/t`: held on the column, not on the table).
 */
async function grantMatrix(query: (sql: string) => Promise<Array<Record<string, any>>>, role: string): Promise<string[]> {
  const rows = await query(grantMatrixSql(role));
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
    expect(await grantOptionsSweep(recreated, 'cmdb_app')).toEqual([]);
    expect(await grantOptionsSweep(baseline, 'cmdb_app')).toEqual([]);

    const [fresh, again] = [await grantMatrix(baseline, 'cmdb_app'), await grantMatrix(recreated, 'cmdb_app')];
    for (const [table, privileges] of Object.entries(EXPECTED)) {
      for (const privilege of PRIVILEGES) expect(fresh).toContain(`${table}|${privilege}|${privileges.includes(privilege) ? 't' : 'f'}`);
    }
    expect(fresh.length).toBeGreaterThan(300);
    expect({ onlyInFresh: fresh.filter(row => !again.includes(row)), onlyInRecreated: again.filter(row => !fresh.includes(row)) })
      .toEqual({ onlyInFresh: [], onlyInRecreated: [] });
    expect(again).toEqual(fresh);

    // A grant option on a table the block restores is a one-row difference: ...|SELECT|t becomes ...|SELECT|g, and nothing else moves.
    expect(fresh.filter(row => row.endsWith('|g'))).toEqual([]);
    await recreated('GRANT SELECT ON public.estate_kpi_snapshots TO cmdb_app WITH GRANT OPTION');
    const grantable = await grantMatrix(recreated, 'cmdb_app');
    expect({ onlyInFresh: fresh.filter(row => !grantable.includes(row)), onlyInGrantable: grantable.filter(row => !fresh.includes(row)) })
      .toEqual({ onlyInFresh: ['public.estate_kpi_snapshots|SELECT|t'], onlyInGrantable: ['public.estate_kpi_snapshots|SELECT|g'] });
  }, 120000);
});

describe('the column section of the grant matrix', () => {
  it('lists a column-only grant and nothing for a table-level grant', async () => {
    const query = open();
    await query('CREATE ROLE cmdb_app LOGIN');
    await query('CREATE TABLE public.t (id int, name text); CREATE TABLE public.u (id int, name text)');
    await query('GRANT SELECT (id) ON public.t TO cmdb_app; GRANT SELECT ON public.u TO cmdb_app');
    const matrix = await grantMatrix(query, 'cmdb_app');
    expect(matrix).toContain('column public.t.id|SELECT|t');
    expect(matrix.filter(row => row.startsWith('column '))).toEqual(['column public.t.id|SELECT|t']);
    expect(matrix).toContain('public.u|SELECT|t');
    await query('REVOKE SELECT (id) ON public.t FROM cmdb_app');
    expect((await grantMatrix(query, 'cmdb_app')).filter(row => row.startsWith('column '))).toEqual([]);
  }, 60000);

  it('lists a column grant option that sits under a table grant without one (a g row), and nothing once the table holds the grant option too', async () => {
    const query = open();
    await query('CREATE ROLE cmdb_app LOGIN');
    await query('CREATE TABLE public.t (id int, name text)');
    const columns = async () => (await grantMatrix(query, 'cmdb_app')).filter(row => row.startsWith('column '));
    await query('GRANT SELECT ON public.t TO cmdb_app');
    expect(await columns()).toEqual([]);
    await query('GRANT SELECT (id) ON public.t TO cmdb_app WITH GRANT OPTION');
    expect(await columns()).toEqual(['column public.t.id|SELECT|g']);
    expect(await grantMatrix(query, 'cmdb_app')).toContain('public.t|SELECT|t'); // the table row alone would have read t
    await query('REVOKE GRANT OPTION FOR SELECT (id) ON public.t FROM cmdb_app');
    expect(await columns()).toEqual([]);
    await query('GRANT SELECT ON public.t TO cmdb_app WITH GRANT OPTION; GRANT SELECT (id) ON public.t TO cmdb_app WITH GRANT OPTION');
    expect(await columns()).toEqual([]); // the table row reads g, so the column rows would only repeat it
    expect(await grantMatrix(query, 'cmdb_app')).toContain('public.t|SELECT|g');
  }, 60000);
});

describe('the grant option field of the grant matrix', () => {
  /** One privilege on one object kind per case: the grant, the matrix row it reads as, and the field that kind reads when nothing is held (a column row exists only while held). */
  const CASES: Array<{ kind: string; target: string; privilege: string; row: string; none: string | null }> = [
    { kind: 'table', target: 'ON TABLE public.t', privilege: 'SELECT', row: 'public.t|SELECT|', none: 'f' },
    { kind: 'sequence', target: 'ON SEQUENCE public.s', privilege: 'USAGE', row: 'public.s|USAGE|', none: 'f' },
    { kind: 'schema', target: 'ON SCHEMA cmdb', privilege: 'CREATE', row: 'schema cmdb|CREATE|', none: 'f' },
    { kind: 'function', target: 'ON FUNCTION public.fn()', privilege: 'EXECUTE', row: 'function fn()|EXECUTE|', none: 'f' },
    { kind: 'column', target: 'ON public.u', privilege: 'SELECT (id)', row: 'column public.u.id|SELECT|', none: null },
  ];

  it.each(CASES)('reads $kind: t when held, g with the grant option, t after REVOKE GRANT OPTION FOR, not held after REVOKE', async c => {
    const query = open();
    await query('CREATE ROLE cmdb_app LOGIN; CREATE SCHEMA cmdb');
    await query(`CREATE TABLE public.t (id int); CREATE TABLE public.u (id int, name text); CREATE SEQUENCE public.s;
      CREATE FUNCTION public.fn() RETURNS int LANGUAGE sql AS 'SELECT 1'; REVOKE EXECUTE ON FUNCTION public.fn() FROM PUBLIC`);
    const reads = async () => (await grantMatrix(query, 'cmdb_app')).filter(row => row.startsWith(c.row));
    const unheld = c.none === null ? [] : [`${c.row}${c.none}`];
    expect(await reads()).toEqual(unheld);
    await query(`GRANT ${c.privilege} ${c.target} TO cmdb_app`);
    expect(await reads()).toEqual([`${c.row}t`]);
    await query(`GRANT ${c.privilege} ${c.target} TO cmdb_app WITH GRANT OPTION`);
    expect(await reads()).toEqual([`${c.row}g`]);
    await query(`REVOKE GRANT OPTION FOR ${c.privilege} ${c.target} FROM cmdb_app`);
    expect(await reads()).toEqual([`${c.row}t`]);
    await query(`REVOKE ${c.privilege} ${c.target} FROM cmdb_app`);
    expect(await reads()).toEqual(unheld);
  }, 60000);
});

describe('the two copies of the grant matrix query', () => {
  const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  it('are the same text: grantMatrixSql for cmdb_app equals the SQL of grant_matrix() in the staging migration contract script', () => {
    const script = readFileSync(join(__dirname, '../../../../../../deploy/test-staging-migrations.sh'), 'utf8');
    const shellSql = /\ngrant_matrix\(\) \{\n\s*owner_psql -c "([^"]*)" \| LC_ALL=C sort\n\}/.exec(script)?.[1];
    expect(shellSql).toBeDefined();
    expect(collapse(shellSql!)).toEqual(collapse(grantMatrixSql('cmdb_app')));
  });
});

describe('the default ACL and database sections of the grant matrix', () => {
  const section = async (query: ReturnType<typeof open>, prefix: string) =>
    (await grantMatrix(query, 'cmdb_app')).filter(row => row.startsWith(prefix));

  it('lists a default privilege that grants to cmdb_app or applies to what cmdb_app creates, and none that touches neither', async () => {
    const query = open();
    await query('CREATE ROLE cmdb_app LOGIN; CREATE ROLE cmdb_user LOGIN; CREATE ROLE other LOGIN');
    expect(await section(query, 'default_acl ')).toEqual([]);
    await query('ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_user IN SCHEMA public GRANT SELECT ON TABLES TO other');
    expect(await section(query, 'default_acl ')).toEqual([]); // neither the grantee nor the role is cmdb_app
    await query('ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_user IN SCHEMA public GRANT SELECT ON TABLES TO cmdb_app');
    expect(await section(query, 'default_acl ')).toEqual(['default_acl cmdb_user public r|cmdb_app|SELECT|t']);
    await query('ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_user IN SCHEMA public GRANT SELECT ON TABLES TO cmdb_app WITH GRANT OPTION');
    expect(await section(query, 'default_acl ')).toEqual(['default_acl cmdb_user public r|cmdb_app|SELECT|g']);
    await query('ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_user GRANT EXECUTE ON FUNCTIONS TO cmdb_app'); // no schema: every schema
    expect(await section(query, 'default_acl ')).toEqual([
      'default_acl cmdb_user * f|cmdb_app|EXECUTE|t',
      'default_acl cmdb_user public r|cmdb_app|SELECT|g',
    ]);
    await query('ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_app IN SCHEMA public GRANT USAGE ON SEQUENCES TO other'); // objects cmdb_app creates
    expect(await section(query, 'default_acl cmdb_app ')).toEqual(['default_acl cmdb_app public S|other|USAGE|t']);
  }, 60000);

  it('lists the CONNECT, CREATE and TEMP privileges of the current database', async () => {
    const query = open();
    await query('CREATE ROLE cmdb_app LOGIN');
    const database = (await query('SELECT current_database() AS name'))[0]!['name'] as string;
    const rows = (fields: string) => fields.split(',').map((field, i) => `database ${database}|${['CONNECT', 'CREATE', 'TEMP'][i]}|${field}`);
    expect(await section(query, 'database ')).toEqual(rows('t,f,t')); // PUBLIC's CONNECT and TEMP reach cmdb_app
    await query(`GRANT CREATE ON DATABASE ${database} TO cmdb_app`);
    expect(await section(query, 'database ')).toEqual(rows('t,t,t'));
    await query(`GRANT CREATE ON DATABASE ${database} TO cmdb_app WITH GRANT OPTION`);
    expect(await section(query, 'database ')).toEqual(rows('t,g,t'));
    await query(`REVOKE CONNECT, TEMP ON DATABASE ${database} FROM PUBLIC`);
    expect(await section(query, 'database ')).toEqual(rows('f,g,f'));
  }, 60000);
});

describe('the function section of the grant matrix and extension functions', () => {
  it('skips an extension\'s functions unless cmdb_app holds an ACL entry of its own on one, and always lists the others', async () => {
    const query = open(UUID_HOST);
    await query('CREATE ROLE cmdb_app LOGIN; CREATE EXTENSION "uuid-ossp"');
    await query(`CREATE FUNCTION public.fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    const functions = async () => (await grantMatrix(query, 'cmdb_app')).filter(row => row.startsWith('function '));
    expect(await functions()).toEqual(['function fn()|EXECUTE|t']); // PUBLIC's EXECUTE on uuid_generate_v4() and the rest is not listed
    await query('GRANT EXECUTE ON FUNCTION uuid_generate_v4() TO cmdb_app');
    expect(await functions()).toEqual(['function fn()|EXECUTE|t', 'function uuid_generate_v4()|EXECUTE|t']);
    await query('GRANT EXECUTE ON FUNCTION uuid_generate_v4() TO cmdb_app WITH GRANT OPTION');
    expect(await functions()).toEqual(['function fn()|EXECUTE|t', 'function uuid_generate_v4()|EXECUTE|g']);
  }, 60000);
});

describe('deploy/cmdb-app-grant-checks.sh, the checks the hosted job sources', () => {
  const CHECKS = join(__dirname, '../../../../../../deploy/cmdb-app-grant-checks.sh');
  const scratch = mkdtempSync(join(tmpdir(), 'cmdb-app-grant-checks-'));
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
  let serial = 0;
  const file = (lines: string[]): string => {
    const path = join(scratch, `f${serial++}`);
    writeFileSync(path, lines.map(line => `${line}\n`).join(''));
    return path;
  };
  /** Runs one function of the sourced file the way the job does (bash, no `set -e`), returning its exit status and stderr. */
  const run = (fn: string, ...args: string[]) => {
    const result = spawnSync('bash', ['-c', 'source "$1"; shift; "$@"', 'bash', CHECKS, fn, ...args], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  /** The held rows of a small matrix (what the fixture lists), and the same matrix as the job's query reports it: with an f row. */
  const HELD = ['column public.t.id|SELECT|t', 'database cmdb|CONNECT|t', 'public.t|SELECT|t', 'schema public|USAGE|t'];
  const CLEAN = [...HELD, 'database cmdb|CREATE|f'];

  describe('check_no_grant_option', () => {
    it('fails on a matrix with a |g line, naming the row', () => {
      const result = run('check_no_grant_option', file([...CLEAN, 'public.estate_kpi_snapshots|SELECT|g']));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('WITH GRANT OPTION');
      expect(result.stderr).toContain('public.estate_kpi_snapshots|SELECT|g');
    });
    it('passes a matrix without one (a g inside a name or an f row is not a grant option)', () => {
      expect(run('check_no_grant_option', file([...CLEAN, 'public.g|SELECT|f', 'public.t|g|f'])).status).toBe(0);
    });
    it('fails when the matrix file cannot be read (grep would exit 2, which an `if` reads as clean)', () => {
      expect(run('check_no_grant_option', join(scratch, 'missing')).status).toBe(1);
    });
  });

  describe('check_matrix_allowlist', () => {
    const expected = file(HELD);
    it('passes when the held rows equal the fixture, whatever f rows the matrix carries', () => {
      expect(run('check_matrix_allowlist', expected, file([...CLEAN, 'public.u|SELECT|f'].sort())).status).toBe(0);
    });
    it('fails on an extra grant, naming it and the fixture', () => {
      const result = run('check_matrix_allowlist', expected, file([...CLEAN, 'public.u|DELETE|t'].sort()));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('extra grant (not in the expected cmdb_app grants): public.u|DELETE|t');
      expect(result.stderr).not.toContain('missing grant');
      expect(result.stderr).toContain(expected);
    });
    it('fails on a missing grant, one that is now f included', () => {
      const result = run('check_matrix_allowlist', expected, file(CLEAN.map(row => row === 'public.t|SELECT|t' ? 'public.t|SELECT|f' : row).sort()));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('missing grant (expected, not held): public.t|SELECT|t');
      expect(result.stderr).not.toContain('extra grant');
    });
    it('reads a grant option as an extra row (|g is not the fixture\'s |t)', () => {
      const result = run('check_matrix_allowlist', expected, file(CLEAN.map(row => row === 'public.t|SELECT|t' ? 'public.t|SELECT|g' : row).sort()));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('extra grant (not in the expected cmdb_app grants): public.t|SELECT|g');
      expect(result.stderr).toContain('missing grant (expected, not held): public.t|SELECT|t');
    });
    it('fails on a matrix that is not in the fixture\'s sort order instead of mis-reporting', () => {
      expect(run('check_matrix_allowlist', expected, file([...CLEAN].reverse())).status).toBe(1);
    });
  });

  describe('check_no_owned_objects, over the SQL of cmdb_app_owned_objects_sql', () => {
    const ownedSql = () => run('cmdb_app_owned_objects_sql').stdout;
    const owned = async (query: ReturnType<typeof open>) => (await query(ownedSql())).map(row => row['owned'] as string);

    it('lists what cmdb_app owns, whatever the kind, and nothing for a role that owns nothing', async () => {
      const query = open();
      await query('CREATE ROLE cmdb_app LOGIN; CREATE ROLE cmdb_user LOGIN; CREATE TABLE public.theirs (id int)');
      await query('ALTER TABLE public.theirs OWNER TO cmdb_user');
      expect(await owned(query)).toEqual([]);
      await query(`CREATE TABLE public.mine (id int); ALTER TABLE public.mine OWNER TO cmdb_app;
        CREATE SCHEMA scratch AUTHORIZATION cmdb_app;
        CREATE FUNCTION public.fn() RETURNS int LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION public.fn() OWNER TO cmdb_app`);
      expect(await owned(query)).toEqual(expect.arrayContaining(['table mine', 'schema scratch', 'function fn()']));
      expect(await owned(query)).not.toContain('table theirs');
      const database = (await query('SELECT current_database() AS name'))[0]!['name'] as string;
      await query(`ALTER DATABASE ${database} OWNER TO cmdb_app`);
      expect(await owned(query)).toContain(`database ${database}`);
    }, 60000);

    it('fails naming each owned object, and passes an empty list', () => {
      const result = run('check_no_owned_objects', file(['table mine', 'schema scratch']));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cmdb_app owns table mine');
      expect(result.stderr).toContain('cmdb_app owns schema scratch');
      expect(run('check_no_owned_objects', file([])).status).toBe(0);
      expect(run('check_no_owned_objects', join(scratch, 'missing')).status).toBe(1);
    });
  });
});

describe('deploy/cmdb-app-grants.expected, the cmdb_app grants a finished install must hold', () => {
  const FIXTURE = join(__dirname, '../../../../../../deploy/cmdb-app-grants.expected');
  const CHECKS = join(__dirname, '../../../../../../deploy/cmdb-app-grant-checks.sh');
  /** Stand-ins for the two TimescaleDB calls of 001 (the extension is not in PGlite), kept out of public and cmdb so they are not in the matrix. */
  const TIMESCALE_STUBS = `CREATE SCHEMA tsstub;
    CREATE FUNCTION tsstub.create_hypertable(regclass, name, if_not_exists boolean DEFAULT false, chunk_time_interval interval DEFAULT NULL)
      RETURNS void LANGUAGE sql AS 'SELECT';
    CREATE FUNCTION tsstub.add_retention_policy(regclass, interval, if_not_exists boolean DEFAULT false) RETURNS void LANGUAGE sql AS 'SELECT';
    SET search_path = public, tsstub`;

  /** Every row cmdb_app holds after all migrations ran, in the job's form: app-login created the role first, the migrator then ran every file in order. */
  async function heldAfterAllMigrations(): Promise<{ all: string[]; held: string[] }> {
    const query = open(UUID_HOST);
    await query(`CREATE ROLE cmdb_user LOGIN SUPERUSER; CREATE ROLE cmdb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; ${TIMESCALE_STUBS}`);
    const database = (await query('SELECT current_database() AS name'))[0]!['name'] as string;
    for (const name of readdirSync(MIGRATIONS).filter(file => file.endsWith('.sql')).sort()) {
      await query(`BEGIN;\n${migration(name).replace('CREATE EXTENSION IF NOT EXISTS timescaledb;', '')}\nCOMMIT;`);
    }
    // The staging database is named cmdb; PGlite's is `postgres`.
    const all = (await grantMatrix(query, 'cmdb_app')).map(row => row.replace(`database ${database}|`, 'database cmdb|')).sort();
    return { all, held: all.filter(row => !row.endsWith('|f')) };
  }

  it('lists exactly the held rows of cmdb_app after every migration (regenerate: UPDATE_GRANT_FIXTURE=1, see deploy/BUILD01-STAGING.md)', async () => {
    const { held } = await heldAfterAllMigrations();
    if (process.env['UPDATE_GRANT_FIXTURE'] === '1') writeFileSync(FIXTURE, held.map(row => `${row}\n`).join(''));
    const expected = readFileSync(FIXTURE, 'utf8').split('\n').filter(line => line !== '');
    expect({ extra: held.filter(row => !expected.includes(row)), missing: expected.filter(row => !held.includes(row)) })
      .toEqual({ extra: [], missing: [] });
    expect(expected).toEqual([...expected].sort()); // the job's comm needs the fixture in byte order
    expect(expected.filter(row => row.endsWith('|g') || row.endsWith('|f'))).toEqual([]);
    for (const [table, privileges] of Object.entries(EXPECTED)) {
      for (const privilege of PRIVILEGES) expect(expected.includes(`${table}|${privilege}|t`)).toBe(privileges.includes(privilege));
    }
  }, 180000);

  it('is accepted by check_matrix_allowlist for that matrix, and refuses it once a grant is added or dropped', async () => {
    const { all } = await heldAfterAllMigrations();
    const dir = mkdtempSync(join(tmpdir(), 'cmdb-app-grants-'));
    try {
      const check = (rows: string[]) => {
        const matrix = join(dir, 'matrix');
        writeFileSync(matrix, [...rows].sort().map(row => `${row}\n`).join(''));
        return spawnSync('bash', ['-c', 'source "$1"; check_matrix_allowlist "$2" "$3"', 'bash', CHECKS, FIXTURE, matrix], { encoding: 'utf8' });
      };
      expect(check(all).status).toBe(0);
      const extra = check([...all, 'public.audit_log|DELETE|t']);
      expect([extra.status, extra.stderr]).toEqual([1, expect.stringContaining('extra grant (not in the expected cmdb_app grants): public.audit_log|DELETE|t')]);
      const dropped = check(all.map(row => row === 'public.audit_log|INSERT|t' ? 'public.audit_log|INSERT|f' : row));
      expect([dropped.status, dropped.stderr]).toEqual([1, expect.stringContaining('missing grant (expected, not held): public.audit_log|INSERT|t')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});

describe('the $hap2126$ block cannot silently drift from the migrations (grants, dynamic grantees, REVOKE, every file)', () => {
  const FIX = 'add the table to the $hap2126$ block in deploy/build01-staging-app-login.sql, to TABLE_MIGRATIONS and EXPECTED in '
    + 'staging-app-login-receipts-grant.test.ts, and to deploy/BUILD01-STAGING.md';
  /** Migrations that name cmdb_app, build a grantee at run time or run a dynamic EXECUTE, yet grant cmdb_app nothing: file name -> why. */
  const NON_APP_GRANTING: Record<string, string> = {
    '001_complete_schema.sql': 'EXECUTE only in a column-diff function and in trigger EXECUTE FUNCTION; every GRANT is TO PUBLIC',
    '005_fix_business_service_hypertable_pks.sql': 'dynamic EXECUTE only of ALTER TABLE ... ADD PRIMARY KEY and DROP CONSTRAINT; no privilege statement',
    '010_business_service_views_org_functions.sql': 'EXECUTE only as a privilege (REVOKE EXECUTE ... FROM PUBLIC); no GRANT to a role',
    '028_change_history_reconciliation_org_provenance.sql': 'one static EXECUTE of REVOKE ... FROM metabase_readonly; the rest is FROM PUBLIC',
    '031_business_service_mapping_ownership.sql': 'EXECUTE only re-creates a view; the one privilege statement is REVOKE ... FROM PUBLIC',
    '032_secret_table_public_grants.sql': 'dynamic REVOKE FROM PUBLIC and metabase_readonly; grants only cmdb_user and metabase_readonly',
    '033_public_business_service_audit_acl.sql': 'dynamic REVOKE FROM PUBLIC; grants only cmdb_user and metabase_readonly',
    '035_itil_record_ownership.sql': 'dynamic EXECUTE only of ALTER TABLE ... ADD COLUMN and ADD CONSTRAINT ... NOT VALID; no privilege statement',
    '036_history_criticality_org_contract.sql': 'dynamic EXECUTE only of ALTER TABLE ... DROP CONSTRAINT; no privilege statement',
    '050_bi_cost_view_grants.sql': 'dynamic REVOKE and GRANT, but the grantee is the literal metabase_readonly',
    '051_bi_view_security_barrier.sql': 'dynamic REVOKE and GRANT, but the grantee is the literal metabase_readonly',
    '052_bi_views_organization_id.sql': 'dynamic EXECUTE only of CREATE OR REPLACE VIEW, COMMENT ON VIEW and ALTER VIEW ... SET (options); no privilege statement',
    '053_business_service_lineage_read_acl.sql': 'names cmdb_app only in a comment; its one GRANT is to cmdb_user',
  };
  const APP_LOGIN_ACL = '045_staging_app_login_acl.sql';
  /**
   * Every `.sql` of the directory except 045 itself, in the migrator's order (migrator.ts `discoverMigrations`: non-recursive, UTF-16
   * sort). The migrator applies any unrecorded file wherever it sorts and app-login creates cmdb_app before it runs, so a file that sorts
   * before 045 can grant or revoke cmdb_app just as a later one can.
   */
  const scannedMigrations = (names: string[]) => names.filter(name => name.endsWith('.sql') && name !== APP_LOGIN_ACL).sort();
  /** A migration's SQL without `--` comments. It cuts from the first `--` even inside a block comment or a string, so it can hide code: only the GRANT table parse and the stale-listing check use it. */
  const stripComments = (sql: string) => sql.replace(/--.*$/gm, '');
  const code = (name: string) => stripComments(migration(name));
  const scanned = scannedMigrations(readdirSync(MIGRATIONS)); // files only: no rollback/ or __tests__/
  // Everything below that decides whether a file is dangerous reads the RAW text: a comment mention is a (loud) false positive, never a hidden grant.
  const namesApp = (sql: string) => /\bcmdb_app\b/i.test(sql);
  const GRANTEE_MARKER = String.raw`(?:%(?:\d+\$)?[IsL]|quote_ident\(|['"]\s*(?:\|\||,))`;
  /** A Unicode-escaped identifier (`U&"cmdb\005fapp"`) can spell a role name in any position of a privilege statement (`TO a, U&"…"`, `TO GROUP U&"…"`, `FROM U&"…"`), so it is refused anywhere in a migration, comments included. No migration needs one. */
  const UNICODE_ESCAPED_IDENTIFIER = /U&\s*"/i;
  const DYNAMIC_GRANTEE = new RegExp(String.raw`\b(?:TO|FROM)\s*${GRANTEE_MARKER}`, 'i');
  const DYNAMIC_GRANT = new RegExp(String.raw`\bGRANT\b[^;]*\bTO\s*${GRANTEE_MARKER}`, 'i');
  const revokesApp = (sql: string) => /\bREVOKE\b[^;]*\bcmdb_app\b/i.test(sql);
  /** A dynamic EXECUTE: every EXECUTE but a trigger's `EXECUTE FUNCTION|PROCEDURE` and the privilege `EXECUTE ON`. It can build any privilege statement at run time, so no text check can read it. */
  const runsDynamicExecute = (sql: string) => /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)/i.test(sql);
  /** A real grant to the app role: a literal GRANT ... TO ... cmdb_app, an ARRAY[... 'cmdb_app' ...] grantee list beside a GRANT, or a dynamic grantee inside a GRANT. */
  const grantsApp = (sql: string) => {
    const text = stripComments(sql);
    return /\bGRANT\b[^;]*\bTO\b[^;]*\bcmdb_app\b/i.test(text)
      || (/\bARRAY\s*\[[^\]]*\bcmdb_app\b[^\]]*\]/i.test(text) && /\bGRANT\b/i.test(text))
      || DYNAMIC_GRANT.test(text);
  };

  /** What is wrong with the listing of `sources` (raw scanned migrations by name): one message per problem, empty when none. */
  const listingProblems = (sources: Record<string, string>, listed: string[], nonApp: Record<string, string>): string[] => {
    const problems: string[] = [];
    for (const name of listed) {
      if (!(name in sources)) problems.push(`${name} is in TABLE_MIGRATIONS but is not a migration`);
      else if (!grantsApp(sources[name]!)) problems.push(`${name} is in TABLE_MIGRATIONS but no longer grants to cmdb_app`);
    }
    for (const name of Object.keys(nonApp)) {
      if (!(name in sources)) problems.push(`${name} is in NON_APP_GRANTING but is not a migration`);
      if (listed.includes(name)) problems.push(`${name} is in both TABLE_MIGRATIONS and NON_APP_GRANTING: list it in one place only`);
    }
    for (const [name, sql] of Object.entries(sources)) {
      if (UNICODE_ESCAPED_IDENTIFIER.test(sql)) {
        problems.push(`${name} contains a Unicode-escaped identifier (U&"..."), which can spell a role name in any position of a privilege statement `
          + 'and which no text check reads: write the name literally');
      }
      if (listed.includes(name)) continue;
      if (revokesApp(sql)) {
        problems.push(`${name} revokes from cmdb_app, which the $hap2126$ block would re-grant: a REVOKE from cmdb_app must be reflected in `
          + 'the $hap2126$ block in deploy/build01-staging-app-login.sql and in EXPECTED, and the file listed in TABLE_MIGRATIONS');
      } else if (name in nonApp) {
        continue;
      } else if (namesApp(sql)) {
        problems.push(`${name} names cmdb_app but is not in TABLE_MIGRATIONS (list it in TABLE_MIGRATIONS, or in NON_APP_GRANTING with a reason `
          + `if it grants cmdb_app nothing): ${FIX}`);
      } else if (DYNAMIC_GRANTEE.test(sql)) {
        problems.push(`${name} uses a dynamic grantee (TO or FROM %I, %s, %L, quote_ident or a concatenation) but is in neither TABLE_MIGRATIONS `
          + `nor NON_APP_GRANTING: list it in one place or the other; ${FIX}`);
      } else if (runsDynamicExecute(sql)) {
        problems.push(`${name} runs a dynamic EXECUTE (not a trigger's EXECUTE FUNCTION or the EXECUTE privilege), so any privilege statement and its `
          + 'grantee can be built at run time and no text check can read it: list it in TABLE_MIGRATIONS, or in NON_APP_GRANTING with a reason '
          + `if it grants cmdb_app nothing; ${FIX}`);
      }
    }
    return problems;
  };
  const sources = () => Object.fromEntries(scanned.map(name => [name, migration(name)]));

  /** The block's `(table, privileges)` tuples, how many VALUES tuples of any shape it holds, and its EXECUTE statements. Whole-line comments go first, and every count reads that one text. */
  const uncommentedOf = (text: string) => text.replace(/^[ \t]*--.*$/gm, ''); // only whole lines: a `--` inside a string must not hide a statement behind it
  const blockText = () => grantBlock();
  const rowListOf = (text: string) => [...text.matchAll(/\('(public\.[a-z_]+)',\s*'([A-Z, ]+)'\)/g)]
    .map(match => [match[1]!, match[2]!.split(',').map(p => p.trim())] as const);
  /**
   * How many rows every `VALUES` list holds, counted loosely: each top-level parenthesised group, whatever is inside it (a space before the comma,
   * `::text`, `$$` quoting, a function call). It must equal the strictly parsed row count, so no row can hide from `rowListOf`.
   */
  const looseRowCount = (text: string): number => {
    let count = 0;
    for (const values of text.matchAll(/\bVALUES\b/gi)) {
      let depth = 0;
      let quoted = false;
      for (let i = values.index! + values[0].length; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) { quoted = c !== "'"; continue; }
        if (c === "'") quoted = true;
        else if (c === '(') { if (depth === 0) count++; depth++; }
        else if (c === ')') { if (depth === 0) break; depth--; }
        else if (c === ';' && depth === 0) break;
      }
    }
    return count;
  };
  const executesOf = (text: string) => text.match(/\bEXECUTE\b/gi) ?? [];
  /** The one statement the block may run, in full: nothing before the closing parenthesis, nothing after it, so no `|| ' WITH GRANT OPTION'`. */
  const BLOCK_GRANT_EXECUTE = `EXECUTE format('GRANT %s ON %s TO cmdb_app', g.privs, g.rel);`;
  const executeStatementsOf = (text: string) => text.match(/\bEXECUTE\b[^;]*(?:;|$)/gi) ?? [];
  const blockRowList = () => rowListOf(uncommentedOf(blockText()));
  const blockRows = () => Object.fromEntries(blockRowList());
  /**
   * The whole DO block, whitespace-normalised, with its VALUES rows as one placeholder: nothing else may differ. The FOR query is a bare
   * `SELECT *` over the rows and the IF guard a bare `to_regclass(g.rel)`, so only the EXECUTE reads g.rel and g.privs, and no
   * projection, cast or concatenation can rewrite them (a grant option spelled `WITH GR' || 'ANT OPTION` in the projection).
   */
  const ROWS = '\u0000';
  const BLOCK_TEMPLATE = `DO $hap2126$ DECLARE g record; BEGIN FOR g IN SELECT * FROM (VALUES ${ROWS} ) AS t(rel, privs) LOOP `
    + `IF to_regclass(g.rel) IS NOT NULL THEN ${BLOCK_GRANT_EXECUTE} END IF; END LOOP; END $hap2126$;`;
  const templateOf = (uncommented: string) => uncommented.replace(/\s+/g, ' ').trim()
    .replace(/\('public\.[a-z_]+',\s*'[A-Z, ]+'\)/g, ROWS).replace(new RegExp(`${ROWS}(?:, ${ROWS})*`, 'g'), ROWS);
  /**
   * What is wrong with the shape of a block beyond its rows: a table twice, a VALUES row that is not strictly `('public.<table>', 'UPPER, CASE')`,
   * anything but one EXECUTE, that one not exactly the full statement, and, as the catch-all once none of those specific rules fired, any
   * other difference from BLOCK_TEMPLATE.
   */
  const blockShapeProblems = (text: string): string[] => {
    const problems: string[] = [];
    const uncommented = uncommentedOf(text);
    const rows = rowListOf(uncommented);
    if (Object.keys(Object.fromEntries(rows)).length !== rows.length) problems.push('a table appears twice in the VALUES rows');
    if (looseRowCount(uncommented) !== rows.length) problems.push('a VALUES row has another shape than (public.<table>, UPPER-CASE privileges)');
    const executes = executesOf(uncommented).length;
    if (executes !== 1) problems.push(`${executes} EXECUTE statements, not the one \`${BLOCK_GRANT_EXECUTE}\` over the VALUES rows`);
    const statements = executeStatementsOf(uncommented);
    if (executes > 0 && statements.some(statement => statement !== BLOCK_GRANT_EXECUTE)) {
      problems.push(`an EXECUTE statement is not exactly \`${BLOCK_GRANT_EXECUTE}\` (anything appended or concatenated to it can add a grant option or another privilege)`);
    }
    // Whatever is outside every EXECUTE statement (those are judged above) may not hold a GRANT or REVOKE.
    if (/\b(?:GRANT|REVOKE)\b/i.test(statements.reduce((rest, statement) => rest.replace(statement, ''), uncommented))) {
      problems.push('a GRANT or REVOKE token outside the one EXECUTE format(...) statement');
    }
    if (problems.length === 0 && templateOf(uncommented) !== BLOCK_TEMPLATE) {
      problems.push('the DO block is not the canonical template apart from its VALUES rows: nothing outside the one EXECUTE may build or rewrite g.rel or g.privs');
    }
    return problems;
  };
  /** A whole `$hap2126$` block as the real script has it, with `values` as the rows, `execute` as the loop body and `extra` after the loop. */
  const canonicalBlock = (values: string, execute: string, extra = '') =>
    `DO $hap2126$\nDECLARE g record;\nBEGIN\n  FOR g IN SELECT * FROM (VALUES ${values}\n  ) AS t(rel, privs) LOOP\n    IF to_regclass(g.rel) IS NOT NULL THEN\n      ${execute}\n`
    + `    END IF;\n  END LOOP;\n${extra}\nEND\n$hap2126$;`;

  /** Tables of every `GRANT ... ON <tables> TO` statement of `sql`, and the first 80 characters of each GRANT whose table cannot be named. */
  const grantStatements = (sql: string): { tables: string[]; unparsed: string[] } => {
    const tables: string[] = [];
    const unparsed: string[] = [];
    for (const loose of sql.matchAll(/\bGRANT\b[^;]*?\bON\b/gi)) {
      const statement = sql.slice(loose.index!).split(';', 1)[0]!;
      const named = /^GRANT\b(?:(?!\bON\b)[^';])*\bON\s+(?:TABLE\s+)?([a-z0-9_."]+(?:\s*,\s*[a-z0-9_."]+)*)\s+TO\b/i.exec(statement);
      if (named) tables.push(...named[1]!.split(',').map(table => table.trim().replace(/"/g, '')));
      else unparsed.push(statement.replace(/\s+/g, ' ').slice(0, 80));
    }
    return { tables, unparsed };
  };
  /** Throws unless every GRANT of the (comment-stripped) listed migration `name` names a table that the block `rows` restore. */
  const assertGrantsRestored = (name: string, sql: string, rows: Record<string, string[]>): void => {
    const { tables, unparsed } = grantStatements(sql);
    if (unparsed.length) {
      throw new Error(`${name} has a GRANT whose table the extraction cannot name (${unparsed.map(s => `"${s}"`).join(', ')}): make `
        + `grantStatements understand it, then ${FIX}`);
    }
    if (tables.length === 0) throw new Error(`${name} is in TABLE_MIGRATIONS but no GRANT ... ON <table> TO statement was found in it`);
    for (const table of tables) {
      if (!(table in rows)) throw new Error(`${name} grants ${table}, which the $hap2126$ block does not restore: ${FIX}`);
    }
  };

  it('takes every .sql file but 045 itself, wherever it sorts, in the migrator order', () => {
    expect(scannedMigrations(['045_staging_app_login_acl.sql', '045a_x.sql', '046_a.sql', 'hotfix_grants.sql', '044_x.sql', '044a_hotfix.sql',
      '000_grants.sql', '045_a.sql', 'README.md', 'rollback']))
      .toEqual(['000_grants.sql', '044_x.sql', '044a_hotfix.sql', '045_a.sql', '045a_x.sql', '046_a.sql', 'hotfix_grants.sql']);
  });

  it('lists every migration that names cmdb_app, builds a grantee at run time or runs a dynamic EXECUTE, and only those', () => {
    expect(scanned).toContain('001_complete_schema.sql');
    expect(scanned).not.toContain(APP_LOGIN_ACL);
    expect(scanned.length).toBeGreaterThan(TABLE_MIGRATIONS.length);
    expect(listingProblems(sources(), TABLE_MIGRATIONS, NON_APP_GRANTING)).toEqual([]);
    // The reason for 053 is checked, not trusted: cmdb_app is only in a comment of 053, and not at all in 055.
    const lineage = '053_business_service_lineage_read_acl.sql';
    expect(NON_APP_GRANTING).toHaveProperty([lineage]);
    expect(namesApp(migration(lineage))).toBe(true);
    expect(namesApp(code(lineage))).toBe(false);
    expect(scanned).toContain('055_auth_credential_events_scope_events.sql');
    expect(namesApp(migration('055_auth_credential_events_scope_events.sql'))).toBe(false);
  });

  it('refuses a dynamic grantee, a REVOKE and an unlisted file in any migration', () => {
    const dynamic = `DO $$ DECLARE login text := 'cmdb_app'; BEGIN EXECUTE format('GRANT SELECT ON public.x TO %I', login); END $$;`;
    const concatenated = `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.x TO ' || 'cmdb_' || 'app'; END $$;`;
    const placeholder = `DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %I', 'cmdb_' || 'app'); END $$;`;
    const revoke = 'REVOKE UPDATE ON public.service_offerings FROM cmdb_app;';
    const problems = (body: string, listed: string[] = [], nonApp: Record<string, string> = {}) =>
      listingProblems({ '057_probe.sql': body }, listed, nonApp);
    expect(problems(dynamic)).toEqual([expect.stringContaining('057_probe.sql names cmdb_app but is not in TABLE_MIGRATIONS')]);
    expect(problems(concatenated)).toEqual([expect.stringContaining('057_probe.sql uses a dynamic grantee')]);
    expect(problems(placeholder)).toEqual([expect.stringContaining('057_probe.sql uses a dynamic grantee')]);
    expect(problems(revoke)).toEqual([expect.stringMatching(/057_probe\.sql revokes from cmdb_app.*reflected in.*\$hap2126\$ block/)]);
    expect(problems(revoke, [], { '057_probe.sql': 'no' })).toHaveLength(1); // a REVOKE cannot be waved through as non-granting
    for (const body of [dynamic, concatenated]) {
      expect(problems(body, ['057_probe.sql'])).toEqual([]);
      expect(problems(body, [], { '057_probe.sql': 'grants cmdb_user only' })).toEqual([]);
    }
    expect(problems(dynamic, ['057_probe.sql'], { '057_probe.sql': 'both' })).toEqual([expect.stringContaining('both TABLE_MIGRATIONS and NON_APP_GRANTING')]);
    // A mention in a comment is a loud false positive that NON_APP_GRANTING answers with a reason, not a silent pass.
    expect(problems('-- GRANT SELECT ON public.x TO cmdb_app\nSELECT 1;')).toEqual([expect.stringContaining('names cmdb_app')]);
    expect(problems('-- GRANT SELECT ON public.x TO cmdb_app\nSELECT 1;', [], { '057_probe.sql': 'comment only' })).toEqual([]);
  });

  it('scans a file that sorts before 045, or after it, with the same rules', () => {
    const grant = 'GRANT SELECT ON public.x TO cmdb_app;';
    for (const early of ['000_grants.sql', '044a_hotfix.sql', '045_a.sql']) {
      const files = scannedMigrations(['045_staging_app_login_acl.sql', early]);
      expect(listingProblems(Object.fromEntries(files.map(name => [name, grant])), [], {}))
        .toEqual([expect.stringContaining(`${early} names cmdb_app but is not in TABLE_MIGRATIONS`)]);
    }
  });

  it('sees code that the comment stripper would hide: a block comment or a string holding two dashes', () => {
    const problems = (body: string) => listingProblems({ '057_probe.sql': body }, [], {});
    const grants = ['/* -- */ GRANT SELECT ON public.x TO cmdb_app;', `SELECT '--'; GRANT SELECT ON public.x TO cmdb_app;`];
    for (const body of grants) {
      expect(stripComments(body)).not.toMatch(/cmdb_app/); // the old pipeline lost it
      expect(problems(body)).toEqual([expect.stringContaining('057_probe.sql names cmdb_app but is not in TABLE_MIGRATIONS')]);
    }
    expect(problems(`SELECT '--'; REVOKE UPDATE ON public.x FROM cmdb_app;`)).toEqual([expect.stringContaining('revokes from cmdb_app')]);
    expect(problems(`/* -- */ DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %I', 'r'); END $$;`))
      .toEqual([expect.stringContaining('uses a dynamic grantee')]);
  });

  it('refuses every spelling of a grantee built at run time, and any dynamic EXECUTE, each through the rule that owns it', () => {
    const GRANTEE = 'uses a dynamic grantee';
    const EXECUTES = 'runs a dynamic EXECUTE';
    const cases: Array<[string, string, string]> = [
      ['numbered placeholder', `DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %1$I', r); END $$;`, GRANTEE],
      ['concat call', `DO $$ BEGIN EXECUTE concat('GRANT SELECT ON public.x TO ', r); END $$;`, GRANTEE],
      ['split literal', `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.x TO cmdb' || '_app'; END $$;`, EXECUTES],
      ['replace call', `DO $$ BEGIN EXECUTE replace('GRANT SELECT ON public.x TO R', 'R', r); END $$;`, EXECUTES],
      ['REVOKE placeholder', `DO $$ BEGIN EXECUTE format('REVOKE SELECT ON public.x FROM %I', r); END $$;`, GRANTEE],
      ['default privileges placeholder', `DO $$ BEGIN EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %1$I', r); END $$;`, GRANTEE],
      ['default privileges, split literal', `DO $$ BEGIN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cmdb' || '_app'; END $$;`, EXECUTES],
      ['default privileges, split keyword', `DO $$ BEGIN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GR' || 'ANT SELECT ON TABLES TO cmdb' || '_app'; END $$;`, EXECUTES],
      ['quoted literal placeholder', `DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %L', r); END $$;`, GRANTEE],
      // Privilege keyword and grantee both built at run time: no literal GRANT, REVOKE or cmdb_app for a text check to see.
      ['split GRANT keyword', `DO $$ BEGIN EXECUTE 'GR' || 'ANT SELECT ON public.x TO cmdb' || '_app'; END $$;`, EXECUTES],
      ['split REVOKE keyword, over-privilege direction', `DO $$ BEGIN EXECUTE 'REV' || 'OKE UPDATE ON public.service_offerings FROM cmdb' || '_app'; END $$;`, EXECUTES],
      ['replace call, no keyword', `DO $$ BEGIN EXECUTE replace('GRXNT SELECT ON public.x TO cmdb_ROLE', 'X', 'A'); END $$;`, EXECUTES],
      ['chr call', `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.x TO cmdb' || chr(95) || 'app'; END $$;`, EXECUTES],
      ['decoded hex', `DO $$ BEGIN EXECUTE convert_from(decode('${Buffer.from('GRANT SELECT ON public.x TO cmdb_app').toString('hex')}', 'hex'), 'UTF8'); END $$;`, EXECUTES],
      ['generic exec helper, no privilege keyword at all', 'CREATE FUNCTION exec(sql text) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE sql; END $f$;', EXECUTES],
      ['plain dynamic EXECUTE', `DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;`, EXECUTES],
      // Lower case: the i flags of DYNAMIC_GRANTEE and of the EXECUTE rule.
      ['lower case placeholder', `do $$ begin execute format('grant select on public.x to %i', r); end $$;`, GRANTEE],
      ['lower case split literal', `do $$ begin execute 'grant select on public.x to cmdb' || '_app'; end $$;`, EXECUTES],
    ];
    for (const [label, body, rule] of cases) {
      const found = listingProblems({ '057_probe.sql': body }, [], {});
      expect([label, found.length]).toEqual([label, 1]);
      expect([label, found[0]]).toEqual([label, expect.stringContaining(`057_probe.sql ${rule}`)]);
      expect(listingProblems({ '057_probe.sql': body }, [], { '057_probe.sql': 'reviewed' })).toEqual([]);
    }
    // A grantee marker alone, with no EXECUTE for the other rule to catch: each alternative of GRANTEE_MARKER and each of TO and FROM.
    const markers: Array<[string, string]> = [
      ['%I', 'GRANT SELECT ON public.x TO %I;'],
      ['%s', 'GRANT SELECT ON public.x TO %s;'],
      ['%L', 'GRANT SELECT ON public.x TO %L;'],
      ['numbered %L', 'GRANT SELECT ON public.x TO %2$L;'],
      ['quote_ident', 'GRANT SELECT ON public.x TO quote_ident(r);'],
      ['concatenation', `GRANT SELECT ON public.x TO ' || r;`],
      ['argument list', `GRANT SELECT ON public.x TO ', r;`],
      ['double-quoted concatenation', 'GRANT SELECT ON public.x TO " || r;'],
      ['FROM', 'REVOKE SELECT ON public.x FROM %I;'],
      ['FROM with a quoted list', `REVOKE SELECT ON public.x FROM ', r;`],
    ];
    for (const [label, body] of markers) {
      expect([label, listingProblems({ '057_probe.sql': body }, [], {})]).toEqual([label, [expect.stringContaining(`057_probe.sql ${GRANTEE}`)]]);
    }
    // A dynamic EXECUTE is only a finding when it is dynamic: a trigger's EXECUTE FUNCTION or PROCEDURE, and the privilege EXECUTE ON, are not.
    for (const body of [
      'CREATE TRIGGER t BEFORE INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION f();',
      'CREATE TRIGGER t BEFORE INSERT ON public.x FOR EACH ROW EXECUTE PROCEDURE f();',
      'create trigger t before insert on public.x for each row execute\n  function f();',
      'REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC;',
      'GRANT EXECUTE ON FUNCTION f() TO cmdb_user;',
      'GRANT SELECT ON public.x TO cmdb_user;', // a privilege statement alone is not a finding either
    ]) {
      expect(listingProblems({ '057_probe.sql': body }, [], {})).toEqual([]);
    }
    // A trigger's EXECUTE does not excuse a dynamic one in the same file.
    expect(listingProblems({ '057_probe.sql': `CREATE TRIGGER t BEFORE INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION f(); DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;` }, [], {}))
      .toEqual([expect.stringContaining(`057_probe.sql ${EXECUTES}`)]);
  });

  it('refuses a listing entry that is not a migration, no longer grants cmdb_app, or sits in both lists', () => {
    const probe = 'DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = \'cmdb_app\') THEN GRANT SELECT ON public.x TO cmdb_user; END IF; END $$;';
    expect(listingProblems({}, ['058_gone.sql'], {})).toEqual(['058_gone.sql is in TABLE_MIGRATIONS but is not a migration']);
    expect(listingProblems({}, [], { '058_gone.sql': 'reason' })).toEqual(['058_gone.sql is in NON_APP_GRANTING but is not a migration']);
    // cmdb_app in a role probe only is not a grant, and neither is a GRANT in a comment.
    expect(listingProblems({ '058_probe.sql': probe }, ['058_probe.sql'], {})).toEqual(['058_probe.sql is in TABLE_MIGRATIONS but no longer grants to cmdb_app']);
    expect(listingProblems({ '058_probe.sql': '-- GRANT SELECT ON public.x TO cmdb_app\nSELECT 1;' }, ['058_probe.sql'], {}))
      .toEqual(['058_probe.sql is in TABLE_MIGRATIONS but no longer grants to cmdb_app']);
    for (const grant of [
      'GRANT SELECT ON public.x TO cmdb_user, cmdb_app;',
      `DO $$ BEGIN FOREACH r IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP EXECUTE format('GRANT SELECT ON public.x TO %I', r); END LOOP; END $$;`,
      `DO $$ BEGIN FOREACH r IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP EXECUTE 'GRANT SELECT ON public.x TO ' || r; END LOOP; END $$;`,
      // Each of the two run-time branches alone: the first has no grantee marker after TO, the second no ARRAY and no literal cmdb_app.
      `DO $$ BEGIN FOREACH r IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP PERFORM note(r); END LOOP; GRANT SELECT ON public.x TO PUBLIC; END $$;`,
      `DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %I', r); END $$;`,
    ]) {
      expect(listingProblems({ '058_ok.sql': grant }, ['058_ok.sql'], {})).toEqual([]);
    }
    // The same two bodies without the grant keyword do not count, so neither branch passes on the other's evidence.
    expect(listingProblems({ '058_no.sql': `DO $$ BEGIN FOREACH r IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP PERFORM note(r); END LOOP; END $$;` }, ['058_no.sql'], {}))
      .toEqual(['058_no.sql is in TABLE_MIGRATIONS but no longer grants to cmdb_app']);
  });

  it('carries exactly the EXPECTED tables and privileges in the block, and no other row or statement', () => {
    expect(blockRows()).toEqual(EXPECTED);
    expect(blockShapeProblems(blockText())).toEqual([]);
  });

  it('cuts the block where PostgreSQL does (the first tag, then `;`) and holds the script to exactly two tags, so a commented tag cannot smuggle a statement past the block checks', () => {
    // The real script: opener and closer only, and the block ends at the closer.
    expect(tagCountProblem(APP_LOGIN_SCRIPT)).toBeUndefined();
    expect(grantBlockOf(APP_LOGIN_SCRIPT).endsWith(`END\n    ${TAG};`)).toBe(true);
    // The reviewer's line: each of the two rules refuses it alone.
    const smuggled = withCommentedTagGrant(APP_LOGIN_SCRIPT);
    expect(() => blockOfScript(smuggled)).toThrow('not followed by `;`'); // the first tag is followed by a space
    expect(tagCountProblem(smuggled)).toContain('holds 4 $hap2126$ tags');
    expect(() => grantBlockOf(smuggled)).toThrow();
    // With the `;` glued to the tag the extraction accepts the cut, but the cut block has lost its closing tag (its last line is the comment):
    // the count rejects it, and so does the template, so no one rule is the only line of defence.
    const glued = withCommentedTagGrant(APP_LOGIN_SCRIPT, COMMENTED_TAG_GRANT.replace(`${TAG} ;`, `${TAG};`));
    const cut = blockOfScript(glued);
    expect(cut.endsWith(`${TAG};`)).toBe(true);
    expect(tagCountProblem(glued)).toContain('holds 4 $hap2126$ tags');
    expect(blockShapeProblems(cut)).toEqual([expect.stringContaining('not the canonical template')]);
    // A tag anywhere else, in a comment above the block or in a trailing comment, is refused by the count alone.
    for (const extra of [`-- ${TAG}\n${APP_LOGIN_SCRIPT}`, `${APP_LOGIN_SCRIPT}\n-- ${TAG}\n`]) {
      expect(tagCountProblem(extra)).toContain('holds 3 $hap2126$ tags');
    }
    // No block at all, or one that never closes with `;`, is refused by the extraction.
    expect(() => blockOfScript('SELECT 1;')).toThrow('has no $hap2126$ DO block');
    expect(() => blockOfScript(`DO ${TAG} BEGIN END ${TAG}\n;`)).toThrow('not followed by `;`');
  });

  it('flags a block sample with a table twice, a tuple of another shape, a second EXECUTE or any GRANT or REVOKE outside the one EXECUTE, through the real block check', () => {
    const sample = (values: string[], executes = 1, extra = '') => canonicalBlock(values.join(', '),
      Array.from({ length: executes }, () => BLOCK_GRANT_EXECUTE).join(' '), extra);
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')", "('public.b', 'SELECT, INSERT')"]))).toEqual([]);
    for (const stray of ["('cmdb.c', 'SELECT')", "('public.c', 'select')", "('public.C', 'SELECT')"]) {
      expect(blockShapeProblems(sample(["('public.a', 'SELECT')", stray]))).toEqual([expect.stringContaining('another shape')]);
    }
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')", "('public.a', 'SELECT')"]))).toEqual([expect.stringContaining('twice')]);
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')"], 0))).toEqual([expect.stringContaining('0 EXECUTE')]);
    // A second statement is refused whatever its case, and a static GRANT or REVOKE is refused with no EXECUTE at all.
    const one = ["('public.a', 'SELECT')"];
    expect(blockShapeProblems(sample(one, 2))).toEqual([expect.stringContaining('2 EXECUTE')]);
    expect(blockShapeProblems(sample(one, 1, `execute 'GRANT DELETE ON public.api_keys TO cmdb_app';`)))
      .toEqual([expect.stringContaining('2 EXECUTE'), expect.stringContaining('not exactly')]);
    expect(blockShapeProblems(sample(one, 1, 'GRANT DELETE ON public.api_keys TO cmdb_app;'))).toEqual([expect.stringContaining('outside the one EXECUTE')]);
    expect(blockShapeProblems(sample(one, 1, 'revoke select on public.api_keys from cmdb_app;'))).toEqual([expect.stringContaining('outside the one EXECUTE')]);
    expect(blockShapeProblems(sample(one, 1, `IF to_regclass('public.zz') IS NOT NULL THEN GRANT DELETE ON public.zz TO cmdb_app; END IF;`)))
      .toEqual([expect.stringContaining('outside the one EXECUTE')]);
    // A comment mention is stripped, but a `--` inside a string does not hide the statement behind it.
    expect(blockShapeProblems(sample(one, 1, '-- GRANT is only mentioned here'))).toEqual([]);
    // An EXECUTE in a whole-line comment is no EXECUTE: `executesOf` reads the same uncommented text as every other count.
    const commentedExecute = sample(one, 1, '-- EXECUTE nothing');
    expect(executesOf(commentedExecute)).toHaveLength(2);
    expect(executesOf(uncommentedOf(commentedExecute))).toHaveLength(1);
    expect(blockShapeProblems(commentedExecute)).toEqual([]);
    expect(blockShapeProblems(sample(one, 1, `SELECT '--'; GRANT DELETE ON public.api_keys TO cmdb_app;`))).toEqual([expect.stringContaining('outside the one EXECUTE')]);
    // The one EXECUTE must be the whole statement: text appended or concatenated after the grantee is a different grant (WITH GRANT OPTION).
    const withGrantOption = (tail: string) => canonicalBlock("('public.a', 'SELECT')",
      `EXECUTE format('GRANT %s ON %s TO cmdb_app'${tail}, g.privs, g.rel);`);
    expect(blockShapeProblems(withGrantOption(''))).toEqual([]);
    for (const tail of [` || ' WITH GR' || 'ANT OPTION'`, ` || ' WITH GRANT OPTION'`, ` || ', cmdb_user'`]) {
      expect([tail, blockShapeProblems(withGrantOption(tail))]).toEqual([tail, [expect.stringContaining('is not exactly')]]);
    }
    expect(blockShapeProblems(`EXECUTE format('GRANT %s ON %s TO cmdb_app', g.privs, g.rel) || ' WITH GRANT OPTION';`))
      .toEqual([expect.stringContaining('is not exactly')]);
  });

  it('refuses a block whose FOR projection or IF guard rewrites g.rel or g.privs, and the real block is the template', () => {
    const real = blockText();
    expect(blockShapeProblems(real)).toEqual([]);
    // The WITH GRANT OPTION split across the FOR projection: the EXECUTE is byte-identical to the canonical statement, so only the template sees it.
    const projected = withGrantOptionProjection(real);
    expect(projected).toContain(BLOCK_GRANT_EXECUTE);
    expect(blockShapeProblems(projected)).toEqual([expect.stringContaining('not the canonical template')]);
    const mutations: Array<[string, (block: string) => string]> = [
      ['projection concatenates the privileges', block => block.replace('FOR g IN SELECT * FROM (VALUES', "FOR g IN SELECT t.rel, t.privs || ' WITH GR' || 'ANT OPTION --' AS privs FROM (VALUES")],
      ['a column list instead of *', block => block.replace('FOR g IN SELECT * FROM (VALUES', 'FOR g IN SELECT t.rel, t.privs FROM (VALUES')],
      ['a WHERE clause on the rows', block => block.replace(') AS t(rel, privs) LOOP', ") AS t(rel, privs) WHERE privs <> '' LOOP")],
      ['a different alias list', block => block.replace('AS t(rel, privs)', 'AS t(privs, rel)')],
      ['the guard rewrites the relation', block => block.replace('to_regclass(g.rel)', "to_regclass(g.rel || '')")],
      ['an extra statement in the loop', block => block.replace('END IF;', "END IF; g.rel := g.rel || ' ';")],
      ['a statement before the loop', block => block.replace('FOR g IN', "PERFORM set_config('x', 'y', true); FOR g IN")],
      ['a different DECLARE', block => block.replace('DECLARE g record;', 'DECLARE g record; x text := 1;')],
    ];
    for (const [label, mutate] of mutations) {
      expect([label, mutate(real) === real]).toEqual([label, false]);
      expect([label, blockShapeProblems(mutate(real))]).toEqual([label, [expect.stringContaining('not the canonical template')]]);
    }
    // Whitespace and whole-line comments are free; a row list of any length is one placeholder.
    expect(blockShapeProblems(real.replace(/\n\s*/g, '\n').replace('BEGIN', 'BEGIN\n-- anything'))).toEqual([]);
  });

  it('runs the strict row parse and the loose row count on the same uncommented text, so a commented strict row cannot pay for a loose row', () => {
    const real = blockText();
    const estate = /\('public\.estate_kpi_snapshots',\s*'SELECT, INSERT'\)/;
    expect(real).toMatch(estate);
    // The estate row becomes a comment, and a loose row that no strict parse reads takes its place: raw-text counts see 6 strict, 6 loose.
    const swapped = real.replace(estate, "-- ('public.estate_kpi_snapshots', 'SELECT, INSERT')\n        ('public.api_keys' ,'DELETE')");
    expect(rowListOf(swapped)).toHaveLength(6);
    expect(looseRowCount(uncommentedOf(swapped))).toBe(6);
    expect(blockShapeProblems(swapped)).toEqual([expect.stringContaining('another shape')]);
    // A commented row alone is no row: it is dropped from the parsed rows too.
    const commented = real.replace(estate, "-- ('public.estate_kpi_snapshots', 'SELECT, INSERT')").replace(/'SELECT, INSERT'\),(\s*)-- /, "'SELECT, INSERT')$1-- ");
    expect(rowListOf(uncommentedOf(commented))).toHaveLength(5);
    expect(blockShapeProblems(commented)).toEqual([]);
  });

  it('counts every VALUES row loosely, so a row that the two strict parsers both skip is still refused', () => {
    const sample = (values: string[]) => canonicalBlock(values.join(', '), BLOCK_GRANT_EXECUTE);
    const good = "('public.a', 'SELECT')";
    const loose: Array<[string, string]> = [
      ['space before the comma', "('public.api_keys' ,'DELETE')"],
      ['text cast', "('public.api_keys'::text, 'DELETE')"],
      ['cast privilege', "('public.api_keys', 'DELETE'::text)"],
      ['dollar quoting', "($$public.api_keys$$, $$DELETE$$)"],
      ['function call', "(lower('PUBLIC.API_KEYS'), 'DELETE')"],
      ['line break after the open parenthesis', "(\n'public.api_keys', 'DELETE')"],
    ];
    for (const [label, row] of loose) {
      expect([label, rowListOf(sample([good, row])).length]).toEqual([label, 1]); // the strict parser does not see the row: only the loose count can
      expect([label, blockShapeProblems(sample([good, row]))]).toEqual([label, [expect.stringContaining('another shape')]]);
    }
    // Two well-formed rows count as two, and a second VALUES list is counted too.
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')", "('public.b', 'SELECT, INSERT')"]))).toEqual([]);
    expect(blockShapeProblems(`${sample([good])}\nSELECT * FROM (VALUES ('public.zz' ,'DELETE')) AS u(rel, privs);`)).toEqual([expect.stringContaining('another shape')]);
  });

  it('refuses a Unicode-escaped identifier anywhere in a migration, in every statement position and whether or not the file is listed', () => {
    const MESSAGE = 'contains a Unicode-escaped identifier';
    const bodies: Array<[string, string]> = [
      ['TO, after another role', 'GRANT SELECT ON public.x TO cmdb_user, U&"cmdb\\005fapp";'],
      ['TO GROUP', 'GRANT SELECT ON public.x TO GROUP U&"cmdb\\005fapp";'],
      ['directly after TO', 'GRANT SELECT ON public.x TO U&"cmdb\\005fapp";'],
      ['REVOKE FROM', 'REVOKE SELECT ON public.x FROM U&"cmdb\\005fapp";'],
      ['REVOKE FROM, after another role', 'REVOKE SELECT ON public.x FROM cmdb_user, U&"cmdb\\005fapp";'],
      ['lower case', 'grant select on public.x to cmdb_user, u&"cmdb\\005fapp";'],
      ['role created with the escape', 'CREATE ROLE U&"cmdb\\005fapp";'],
    ];
    for (const [label, body] of bodies) {
      expect([label, listingProblems({ '057_probe.sql': body }, [], {})]).toEqual([label, [expect.stringContaining(`057_probe.sql ${MESSAGE}`)]]);
      // The rule has no exemption: a listing or a reason does not excuse it (a listed file that grants nothing to cmdb_app adds its own finding).
      expect([label, listingProblems({ '057_probe.sql': body }, ['057_probe.sql'], {})]).toEqual([label, expect.arrayContaining([expect.stringContaining(MESSAGE)])]);
      expect([label, listingProblems({ '057_probe.sql': body }, [], { '057_probe.sql': 'reviewed' })]).toEqual([label, [expect.stringContaining(MESSAGE)]]);
    }
    // Inside an EXECUTE it is refused next to the dynamic-EXECUTE finding, not instead of it.
    expect(listingProblems({ '057_probe.sql': `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.x TO U&"cmdb\\005Fapp"'; END $$;` }, [], {}))
      .toEqual([expect.stringContaining(MESSAGE), expect.stringContaining('runs a dynamic EXECUTE')]);
    // A plain quoted identifier and an `&` elsewhere are not findings.
    expect(listingProblems({ '057_probe.sql': `SELECT 1 & 2; GRANT SELECT ON public.x TO "cmdb_user";` }, [], {})).toEqual([]);
  });

  it('names every table of every GRANT of the granting migrations, and the block restores each', () => {
    expect(grantStatements('GRANT SELECT ON public.ci_v2, "public"."Xy" TO cmdb_app; GRANT SELECT (a, b) ON TABLE t TO cmdb_user;'))
      .toEqual({ tables: ['public.ci_v2', 'public.Xy', 't'], unparsed: [] });
    expect(grantStatements(`EXECUTE format('GRANT SELECT ON %s TO %I', t, r); GRANT ALL ON ALL TABLES IN SCHEMA public TO cmdb_app;`).unparsed)
      .toEqual([`GRANT SELECT ON %s TO %I', t, r)`, 'GRANT ALL ON ALL TABLES IN SCHEMA public TO cmdb_app']);
    const rows = blockRows();
    for (const name of TABLE_MIGRATIONS) assertGrantsRestored(name, code(name), rows);
  });

  it('refuses a listed migration whose GRANT cannot be read, names no table, or names a table the block does not restore', () => {
    const rows = { 'public.a': ['SELECT'] };
    expect(() => assertGrantsRestored('057_probe.sql', 'GRANT SELECT ON public.a TO cmdb_app;', rows)).not.toThrow();
    expect(() => assertGrantsRestored('057_probe.sql', 'SELECT 1;', rows)).toThrow('no GRANT ... ON <table> TO statement was found');
    expect(() => assertGrantsRestored('057_probe.sql', 'GRANT SELECT ON public.b TO cmdb_app;', rows)).toThrow('grants public.b, which the $hap2126$ block does not restore');
    expect(() => assertGrantsRestored('057_probe.sql', 'GRANT ALL ON ALL TABLES IN SCHEMA public TO cmdb_app;', rows)).toThrow('cannot name');
  });
});
