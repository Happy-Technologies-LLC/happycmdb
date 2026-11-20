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
import { readdirSync, readFileSync } from 'fs';
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

/**
 * Every privilege of `role` on every relation, schema and function of public and cmdb, as sorted `object|privilege|t/f` rows, plus
 * the column-only privileges (`column <schema>.<table>.<column>|<PRIVILEGE>|t`: held on the column, not on the table). The
 * same query runs against a real server in `grant_matrix()` of deploy/test-staging-migrations.sh: keep the two texts identical.
 */
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
      FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname IN ('public', 'cmdb')
    UNION ALL
    SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname || '|' || p.privilege || '|t'
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('${role}', a.attrelid, a.attnum, p.privilege)
        AND NOT has_table_privilege('${role}', a.attrelid, p.privilege)`);
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
});

describe('the $hap2126$ block cannot silently drift from the migrations (grants, dynamic grantees, REVOKE, every file)', () => {
  const FIX = 'add the table to the $hap2126$ block in deploy/build01-staging-app-login.sql, to TABLE_MIGRATIONS and EXPECTED in '
    + 'staging-app-login-receipts-grant.test.ts, and to deploy/BUILD01-STAGING.md';
  /** Migrations that name cmdb_app, build a grantee at run time or run EXECUTE with a privilege statement, yet grant cmdb_app nothing: file name -> why. */
  const NON_APP_GRANTING: Record<string, string> = {
    '001_complete_schema.sql': 'EXECUTE only in a column-diff function and in trigger EXECUTE FUNCTION; every GRANT is TO PUBLIC',
    '010_business_service_views_org_functions.sql': 'EXECUTE only as a privilege (REVOKE EXECUTE ... FROM PUBLIC); no GRANT to a role',
    '020_auth_credential_events.sql': 'EXECUTE only in trigger EXECUTE FUNCTION; the one privilege statement is REVOKE ALL ... FROM PUBLIC',
    '028_change_history_reconciliation_org_provenance.sql': 'one static EXECUTE of REVOKE ... FROM metabase_readonly; the rest is FROM PUBLIC',
    '031_business_service_mapping_ownership.sql': 'EXECUTE only re-creates a view; the one privilege statement is REVOKE ... FROM PUBLIC',
    '032_secret_table_public_grants.sql': 'dynamic REVOKE FROM PUBLIC and metabase_readonly; grants only cmdb_user and metabase_readonly',
    '033_public_business_service_audit_acl.sql': 'dynamic REVOKE FROM PUBLIC; grants only cmdb_user and metabase_readonly',
    '041_discovery_definition_migration_ledger.sql': 'EXECUTE only in trigger EXECUTE FUNCTION; the privilege statements are REVOKE ... FROM PUBLIC',
    '050_bi_cost_view_grants.sql': 'dynamic REVOKE and GRANT, but the grantee is the literal metabase_readonly',
    '051_bi_view_security_barrier.sql': 'dynamic REVOKE and GRANT, but the grantee is the literal metabase_readonly',
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
  const GRANTEE_MARKER = String.raw`(?:%(?:\d+\$)?[IsL]|quote_ident\(|U&\s*"|['"]\s*(?:\|\||,))`;
  const DYNAMIC_GRANTEE = new RegExp(String.raw`\b(?:TO|FROM)\s*${GRANTEE_MARKER}`, 'i');
  const DYNAMIC_GRANT = new RegExp(String.raw`\bGRANT\b[^;]*\bTO\s*${GRANTEE_MARKER}`, 'i');
  const revokesApp = (sql: string) => /\bREVOKE\b[^;]*\bcmdb_app\b/i.test(sql);
  /** Dynamic SQL next to a privilege statement: any spelling of the grantee can be built at run time, so no text check can read it. */
  const dynamicPrivileges = (sql: string) =>
    /\bEXECUTE\b/i.test(sql) && /\b(?:GRANT|REVOKE)\b|\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(sql);
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
        problems.push(`${name} uses a dynamic grantee (TO or FROM %I, %s, %L, quote_ident, U& or a concatenation) but is in neither TABLE_MIGRATIONS `
          + `nor NON_APP_GRANTING: list it in one place or the other; ${FIX}`);
      } else if (dynamicPrivileges(sql)) {
        problems.push(`${name} runs EXECUTE beside a GRANT, REVOKE or ALTER DEFAULT PRIVILEGES, so its grantee can be built at run time and no `
          + 'text check can read it: list it in TABLE_MIGRATIONS, or in NON_APP_GRANTING with a reason if it grants cmdb_app nothing; '
          + FIX);
      }
    }
    return problems;
  };
  const sources = () => Object.fromEntries(scanned.map(name => [name, migration(name)]));

  /** The block's `(table, privileges)` tuples, how many VALUES tuples of any shape it holds, and its EXECUTE statements. Raw text: nothing is stripped out of sight. */
  const blockText = () => grantBlock();
  const rowListOf = (text: string) => [...text.matchAll(/\('(public\.[a-z_]+)',\s*'([A-Z, ]+)'\)/g)]
    .map(match => [match[1]!, match[2]!.split(',').map(p => p.trim())] as const);
  const tuplesOf = (text: string) => [...text.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map(match => match[0]);
  const executesOf = (text: string) => text.match(/\bEXECUTE\b/g) ?? [];
  const blockRowList = () => rowListOf(blockText());
  const blockRows = () => Object.fromEntries(blockRowList());
  /** What is wrong with the shape of a block beyond its rows: a table twice, a tuple of another shape (`('cmdb.x', 'SELECT, DELETE')`, a lower-case privilege), anything but one EXECUTE. */
  const blockShapeProblems = (text: string): string[] => {
    const problems: string[] = [];
    const rows = rowListOf(text);
    if (Object.keys(Object.fromEntries(rows)).length !== rows.length) problems.push('a table appears twice in the VALUES rows');
    if (tuplesOf(text).length !== rows.length) problems.push('a VALUES tuple has another shape than (public.<table>, UPPER-CASE privileges)');
    const executes = executesOf(text).length;
    if (executes !== 1) problems.push(`${executes} EXECUTE statements, not the one \`EXECUTE format('GRANT %s ON %s TO cmdb_app', ...)\` over the VALUES rows`);
    return problems;
  };

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

  it('lists every migration that names cmdb_app, builds a grantee at run time or runs EXECUTE beside a privilege statement, and only those', () => {
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

  it('refuses every spelling of a grantee built at run time, and any EXECUTE beside a GRANT, REVOKE or ALTER DEFAULT PRIVILEGES', () => {
    const cases: Array<[string, string]> = [
      ['numbered placeholder', `DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %1$I', r); END $$;`],
      ['concat call', `DO $$ BEGIN EXECUTE concat('GRANT SELECT ON public.x TO ', r); END $$;`],
      ['split literal', `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.x TO cmdb' || '_app'; END $$;`],
      ['replace call', `DO $$ BEGIN EXECUTE replace('GRANT SELECT ON public.x TO R', 'R', r); END $$;`],
      ['unicode escape in EXECUTE', `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.x TO U&"cmdb\\005Fapp"'; END $$;`],
      ['unicode escape, static', 'GRANT SELECT ON public.x TO U&"cmdb\\005Fapp";'],
      ['REVOKE placeholder', `DO $$ BEGIN EXECUTE format('REVOKE SELECT ON public.x FROM %I', r); END $$;`],
      ['default privileges placeholder', `DO $$ BEGIN EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %1$I', r); END $$;`],
      ['default privileges, split literal', `DO $$ BEGIN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cmdb' || '_app'; END $$;`],
      ['quoted literal placeholder', `DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.x TO %L', r); END $$;`],
    ];
    for (const [label, body] of cases) {
      const found = listingProblems({ '057_probe.sql': body }, [], {});
      expect([label, found.length]).toEqual([label, 1]);
      expect(listingProblems({ '057_probe.sql': body }, [], { '057_probe.sql': 'reviewed' })).toEqual([]);
    }
    // EXECUTE alone, or a privilege statement alone, is not a finding.
    expect(listingProblems({ '057_probe.sql': `DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;` }, [], {})).toEqual([]);
    expect(listingProblems({ '057_probe.sql': 'GRANT SELECT ON public.x TO cmdb_user;' }, [], {})).toEqual([]);
    // Only the EXECUTE rule can name a grantee that is never spelled out.
    expect(listingProblems({ '057_probe.sql': cases[2]![1] }, [], {})).toEqual([expect.stringContaining('runs EXECUTE beside a GRANT, REVOKE')]);
    expect(listingProblems({ '057_probe.sql': cases[0]![1] }, [], {})).toEqual([expect.stringContaining('uses a dynamic grantee')]);
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
    ]) {
      expect(listingProblems({ '058_ok.sql': grant }, ['058_ok.sql'], {})).toEqual([]);
    }
  });

  it('carries exactly the EXPECTED tables and privileges in the block, and no other row or statement', () => {
    expect(blockRows()).toEqual(EXPECTED);
    expect(blockShapeProblems(blockText())).toEqual([]);
  });

  it('flags a block sample with a table twice, a tuple of another shape or a second EXECUTE, through the real block check', () => {
    const sample = (values: string[], executes = 1) => `FOR g IN SELECT * FROM (VALUES ${values.join(', ')}) AS t(rel, privs) LOOP `
      + Array.from({ length: executes }, () => `EXECUTE format('GRANT %s ON %s TO cmdb_app', g.privs, g.rel);`).join(' ') + ' END LOOP;';
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')", "('public.b', 'SELECT, INSERT')"]))).toEqual([]);
    for (const stray of ["('cmdb.c', 'SELECT')", "('public.c', 'select')", "('public.C', 'SELECT')"]) {
      expect(blockShapeProblems(sample(["('public.a', 'SELECT')", stray]))).toEqual([expect.stringContaining('another shape')]);
    }
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')", "('public.a', 'SELECT')"]))).toEqual([expect.stringContaining('twice')]);
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')"], 2))).toEqual([expect.stringContaining('2 EXECUTE')]);
    expect(blockShapeProblems(sample(["('public.a', 'SELECT')"], 0))).toEqual([expect.stringContaining('0 EXECUTE')]);
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
