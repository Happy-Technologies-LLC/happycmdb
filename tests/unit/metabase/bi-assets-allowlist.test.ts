// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-659: the BI role (metabase_readonly) reads only the audited reporting views listed in
// infrastructure/database/metabase-init.sql (HAP-630). Every relation a shipped Metabase dashboard or saved
// question queries must be on that list, or Metabase answers `permission denied` for the card.
// The assets cannot run against a live Metabase here, so they are checked statically; the two views HAP-659
// adds or recreates are executed in PGlite as the BI role.
import { fork } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const metabase = 'infrastructure/metabase';
const viewsDir = 'infrastructure/database/views';

/** Allowlisted relations, schema-qualified (`public.` when the bootstrap names none). */
function allowlist(): Set<string> {
  const array = /ARRAY\[([^\]]*)\]/.exec(read('infrastructure/database/metabase-init.sql'))![1];
  return new Set([...array.matchAll(/'([^']+)'/g)].map(m => (m[1].includes('.') ? m[1] : `public.${m[1]}`)));
}

const CLAUSE_END = /^(?:WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|INTERSECT|EXCEPT|WINDOW|OFFSET|FETCH)\b/i;

/** The comma-separated items of every FROM list (`FROM a, b JOIN c ON ..., d`), parenthesized content blanked to `(`. */
function fromItems(text: string): string[] {
  const items: string[] = [];
  for (const from of text.matchAll(/\bFROM\b/gi)) {
    const rest = text.slice(from.index + 4);
    let depth = 0;
    let item = '';
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (depth === 0 && (ch === ';' || (/\W/.test(rest[i - 1] ?? ' ') && CLAUSE_END.test(rest.slice(i))))) break;
      if (ch === ')' && depth === 0) break;
      if (ch === '(') { if (depth === 0) item += '('; depth++; }
      else if (ch === ')') depth--;
      else if (depth === 0 && ch === ',') { items.push(item); item = ''; }
      else if (depth === 0) item += ch;
    }
    items.push(item);
  }
  return items;
}

/** Relations named in a FROM list or after JOIN, schema-qualified; CTE names and EXTRACT(x FROM ...) excluded. */
function relations(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/EXTRACT\s*\(\s*\w+\s+FROM/gi, 'EXTRACT(');
  const ctes = new Set([...text.matchAll(/\b(\w+)\s+AS\s*\(/gi)].map(m => m[1].toLowerCase()));
  const names = [
    // an item starts with its relation (a subquery starts with `(`); each JOIN inside the item names another
    ...fromItems(text).flatMap(item => [
      /^\s*(?:ONLY\s+|LATERAL\s+)?("?[A-Za-z_]\w*"?(?:\.\w+)?)/i.exec(item)?.[1],
      ...[...item.matchAll(/\bJOIN\s+("?[A-Za-z_]\w*"?(?:\.\w+)?)/gi)].map(m => m[1]),
    ]),
  ];
  const found = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    const name = raw.replace(/"/g, '').toLowerCase();
    if (!ctes.has(name)) found.add(name.includes('.') ? name : `public.${name}`);
  }
  return [...found];
}

const unreadable = (sql: string, allowed = allowlist()) => relations(sql).filter(r => !allowed.has(r));

function dashboardQueries(file: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown, key = ''): void => {
    if (typeof node === 'string' && key === 'query') out.push(node);
    else if (Array.isArray(node)) node.forEach(n => walk(n, key));
    else if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => walk(v, k));
  };
  walk(JSON.parse(read(file)));
  return out;
}

const dashboards = readdirSync(join(root, metabase, 'dashboards')).filter(f => f.endsWith('.json')).sort();
const assets: Array<[string, string]> = [
  ...dashboards.flatMap(f => dashboardQueries(`${metabase}/dashboards/${f}`).map(q => [`dashboards/${f}`, q] as [string, string])),
  ['questions/common-questions.sql', read(`${metabase}/questions/common-questions.sql`)],
];

describe('Metabase assets query only what the BI role can read (HAP-659)', () => {
  describe('relation extraction', () => {
    it('finds FROM/JOIN relations and skips EXTRACT(.. FROM ..), subqueries and CTE names', () => {
      const sql = `WITH recent AS (SELECT 1 FROM cmdb.dim_ci)
        SELECT EXTRACT(EPOCH FROM (NOW() - i.reported_at)) FROM recent r
        JOIN public.v_a a ON true LEFT JOIN "v_b" b ON true, (SELECT 1 FROM v_c) s -- FROM commented`;
      expect(relations(sql).sort()).toEqual(['cmdb.dim_ci', 'public.v_a', 'public.v_b', 'public.v_c']);
    });

    it('flags a raw table that is not on the allowlist and accepts one that is', () => {
      const allowed = new Set(['public.v_cost_by_tower']);
      expect(unreadable('SELECT * FROM itil_incidents i JOIN v_cost_by_tower t ON true', allowed))
        .toEqual(['public.itil_incidents']);
      expect(unreadable('SELECT * FROM v_cost_by_tower', allowed)).toEqual([]);
    });

    it('finds relations after a comma join, in a mixed list and inside a subquery', () => {
      expect(relations('SELECT 1 FROM v_cost_by_tower t, cmdb.dim_ci d WHERE t.x = d.x').sort())
        .toEqual(['cmdb.dim_ci', 'public.v_cost_by_tower']);
      expect(relations('SELECT 1 FROM a JOIN b ON f(a.x, b.x) = 1, c, (SELECT 1 FROM d, e) s ORDER BY 1').sort())
        .toEqual(['public.a', 'public.b', 'public.c', 'public.d', 'public.e']);
      expect(unreadable('SELECT * FROM v_cost_by_tower t, itil_incidents i', new Set(['public.v_cost_by_tower'])))
        .toEqual(['public.itil_incidents']);
    });
  });

  it.each(assets.map(([file, sql]) => [file, sql.replace(/\s+/g, ' ').slice(0, 90), sql]))(
    '%s: %s', (_file, _label, sql) => {
      expect(relations(sql)).not.toEqual([]); // an extractor that finds nothing would pass the next line vacuously
      expect(unreadable(sql)).toEqual([]);
    });

  it.each(readdirSync(join(root, viewsDir)).filter(f => f.endsWith('.sql')).sort())(
    '%s grants metabase_readonly only allowlisted views', file => {
      const statements = read(`${viewsDir}/${file}`).replace(/--[^\n]*/g, '').split(/;\s*\n/);
      const granted = statements.flatMap(s => [...s.matchAll(/GRANT\s+SELECT\s+ON\s+([\w.]+)\s+TO\s+metabase_readonly/gi)])
        .map(m => (m[1].includes('.') ? m[1] : `public.${m[1]}`));
      expect(granted.filter(v => !allowlist().has(v))).toEqual([]);
    });

  // The cost views and the BI grants run as the shipped SQL files do, as the BI role, in PGlite.
  describe('BI cost views are granted by shape (PGlite)', () => {
    const host = fork(join(root, 'packages/api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [],
      { serialization: 'advanced' });
    let serial = 0;
    const pending = new Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (e: Error) => void }>();
    host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, unknown>[]; error?: string }) => {
      const reply = pending.get(id)!;
      pending.delete(id);
      if (error) reply.reject(new Error(error)); else reply.resolve(rows);
    });
    const exec = (sql: string, op: 'exec' | 'query' = 'exec') => {
      const id = serial++;
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>[]>();
      pending.set(id, { resolve, reject });
      host.send({ id, op, sql, params: [] });
      return promise;
    };
    const asBi = async (sql: string) => {
      await exec('SET ROLE metabase_readonly');
      try { return await exec(sql, 'query'); } finally { await exec('RESET ROLE'); }
    };
    const secret = 'SECRET-TOKEN-VALUE';
    const row = (i: number, cost: number, util: unknown, extra = '') =>
      `('ci-${i}', 'name-${i}', 'server', 'active', 'production', true,
        '{"monthly_cost": ${cost}}', '{}', '{"utilization_pct": ${JSON.stringify(util)}, "api_token": "${secret}"${extra}}')`;
    /** Top-level statements, `--` comments dropped, dollar-quoted bodies and string literals kept whole. */
    function splitStatements(sql: string): string[] {
      const text = sql.replace(/--[^\n]*/g, '');
      const out: string[] = [];
      let cur = '';
      for (let i = 0; i < text.length;) {
        const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40));
        if (tag) {
          const end = text.indexOf(tag[0], i + tag[0].length);
          const stop = end < 0 ? text.length : end + tag[0].length;
          cur += text.slice(i, stop);
          i = stop;
        } else if (text[i] === "'") {
          let j = i + 1;
          while (j < text.length && (text[j] !== "'" || text[j + 1] === "'")) j += text[j] === "'" ? 2 : 1;
          cur += text.slice(i, j + 1);
          i = j + 1;
        } else if (text[i] === ';') {
          out.push(cur.trim());
          cur = '';
          i += 1;
        } else {
          cur += text[i];
          i += 1;
        }
      }
      return [...out, cur.trim()].filter(Boolean);
    }
    /** psql without ON_ERROR_STOP: every statement runs and a failure only prints an error. Returns those errors. */
    const runLoose = async (statements: string[]) => {
      const errors: string[] = [];
      for (const statement of statements) await exec(statement).catch((e: Error) => { errors.push(e.message); });
      return errors;
    };

    const costStatements = splitStatements(read(`${viewsDir}/cost-analysis.sql`)).filter(s =>
      /^(CREATE (OR REPLACE )?VIEW|COMMENT ON VIEW) v_(top_cost_drivers(_bi)?|underutilized_resources)\b/.test(s) || /^DO\b/.test(s));
    const costViewDdl = costStatements.filter(s => !/^DO\b/.test(s));
    const initSql = read('infrastructure/database/metabase-init.sql');
    // the same slice the hosted ACL job (hap630-acl.integration.test.ts) runs
    const biSetup = initSql.slice(initSql.indexOf('-- Only audited reporting views'), initSql.indexOf('-- FD-6 health reporting'));
    const migration050 = `BEGIN;\n${read('packages/database/src/postgres/migrations/050_bi_cost_view_grants.sql')}\nCOMMIT;`;
    const migration051 = `BEGIN;\n${read('packages/database/src/postgres/migrations/051_bi_view_security_barrier.sql')}\nCOMMIT;`;
    const denied = (sql: string) => expect(asBi(sql)).rejects.toThrow(/permission denied/);

    beforeAll(async () => {
      expect(costStatements.length).toBeGreaterThanOrEqual(7);
      expect(biSetup).toContain('DO $bi$');
      await exec(`CREATE ROLE metabase_readonly;
        CREATE SCHEMA cmdb;
        CREATE TABLE cmdb.dim_ci (ci_key serial, ci_id text, ci_name text, ci_type text, ci_status text, environment text,
          is_current boolean, tbm_attributes jsonb, bsm_attributes jsonb, metadata jsonb, updated_at timestamptz DEFAULT now(),
          organization_id uuid);
        -- the tables the other cost views read (columns as the views use them)
        CREATE TABLE business_services (id int, name text, tbm_attributes jsonb, bsm_attributes jsonb, operational_status text,
          technical_owner text, updated_at timestamptz);
        CREATE TABLE service_dependencies (source_id int, source_type text, dependency_type text, target_id int, target_type text);
        CREATE TABLE business_capabilities (id int, name text);
        CREATE TABLE cmdb.fact_ci_changes (ci_key int, changed_at timestamptz, field_name text, new_value text);
        CREATE TABLE tbm_cost_pools (id int, cost_center text, business_unit text, name text, cost_pool_type text,
          monthly_budget numeric, annual_budget numeric, owner text, is_active boolean);
        CREATE TABLE tbm_depreciation_schedules (ci_id text, ci_name text, purchase_date date, purchase_cost numeric,
          useful_life_months int, depreciation_method text, monthly_depreciation numeric, accumulated_depreciation numeric,
          current_book_value numeric, fully_depreciated boolean, fully_depreciated_at timestamptz, is_active boolean);
        INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, tbm_attributes, bsm_attributes, metadata)
        VALUES ${[
          ...Array.from({ length: 25 }, (_, i) => row(i, 1000 + i, 90)), // 25 active, costed, well utilized
          row(100, 500, 40), // underutilized: 40% of $500
          row(101, 500, 'n/a'), // non-numeric utilization must not raise
          row(102, 500, 60),
          row(103, 0, 10), // no cost
        ].join(',')}`);
    }, 60000);
    const barrierViews = ['v_executive_cost_summary', 'v_cost_by_tower', 'v_cost_trends', 'v_unit_economics',
      'v_cloud_vs_onprem_costs', 'v_cost_allocation_summary', 'v_depreciation_summary', 'v_underutilized_resources'];
    beforeEach(async () => {
      await exec(`DROP VIEW IF EXISTS v_top_cost_drivers, v_top_cost_drivers_bi, ${barrierViews.join(', ')} CASCADE;
        DROP TYPE IF EXISTS cj CASCADE; DROP DOMAIN IF EXISTS dj CASCADE;
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM metabase_readonly`);
    });
    afterAll(() => { host.kill(); });

    it('fresh install: BI reads the bounded views with no metadata column and no secret; v_top_cost_drivers and the raw dimension stay denied', async () => {
      expect(await runLoose(costStatements)).toEqual([]);
      const top = await asBi('SELECT * FROM v_top_cost_drivers_bi');
      expect(top).toHaveLength(20);
      expect(top[0]['ci_id']).toBe('ci-24');
      expect(Object.keys(top[0])).not.toContain('metadata');
      const idle = await asBi('SELECT * FROM v_underutilized_resources');
      expect(idle.map(r => r['ci_id'])).toEqual(['ci-100']);
      expect(Number(idle[0]['potential_savings'])).toBeCloseTo(300);
      expect(JSON.stringify([top, idle])).not.toContain(secret);
      await denied('SELECT * FROM v_top_cost_drivers');
      await denied('SELECT metadata FROM cmdb.dim_ci');
    });

    it('BI setup grants the bounded views by name and shape, and never v_top_cost_drivers (HAP-659 B1)', async () => {
      await exec(costViewDdl.join(';\n'));
      await exec(biSetup);
      expect(await asBi('SELECT ci_id FROM v_top_cost_drivers_bi')).toHaveLength(20);
      expect(await asBi('SELECT ci_id FROM v_underutilized_resources')).toHaveLength(1);
      await denied('SELECT * FROM v_top_cost_drivers'); // present with ci.metadata, on no allowlist
    });

    // B1: the old shape is already in the database when BI setup (the documented metabase-init.sql re-run) executes.
    it.each([
      ['v_top_cost_drivers', 'ci_id, metadata'],
      ['v_top_cost_drivers_bi', 'ci_id, metadata'],
      ['v_top_cost_drivers_bi', 'ci_id, tbm_attributes AS attrs'], // a jsonb column under another name
      ['v_underutilized_resources', 'ci_id, metadata'],
    ])('old-shape %s (%s) present, then BI setup runs: the BI read is denied', async (view, columns) => {
      await exec(`CREATE VIEW ${view} AS SELECT ${columns} FROM cmdb.dim_ci`);
      await exec(`GRANT SELECT ON ${view} TO metabase_readonly`); // a grant left by an earlier bootstrap
      await exec(biSetup);
      await denied(`SELECT * FROM ${view}`);
    });

    // B2: cost-analysis.sql runs without ON_ERROR_STOP; a stale old-shape view makes its CREATE fail.
    it.each([
      ['v_top_cost_drivers_bi', 'ci_id, metadata'],
      ['v_underutilized_resources', 'ci_id, tbm_attributes AS attrs'],
    ])('a failed CREATE leaves old-shape %s in place: cost-analysis.sql without ON_ERROR_STOP leaves BI no access (HAP-659 B2)', async (view, columns) => {
      await exec(`CREATE VIEW ${view} AS SELECT ${columns} FROM cmdb.dim_ci`);
      await exec(`GRANT SELECT ON ${view} TO metabase_readonly`);
      const errors = await runLoose(costStatements);
      expect(errors.some(e => /cannot (change name of|drop columns from) view/.test(e))).toBe(true); // the repro condition
      await denied(`SELECT * FROM ${view}`);
      await denied('SELECT * FROM v_top_cost_drivers');
    });

    it('migration 050 grants the bounded views to BI after a restore, and only them', async () => {
      await exec(costViewDdl.join(';\n'));
      await exec(migration050);
      expect(await asBi('SELECT ci_id FROM v_top_cost_drivers_bi')).toHaveLength(20);
      expect(await asBi('SELECT ci_id FROM v_underutilized_resources')).toHaveLength(1);
      await denied('SELECT * FROM v_top_cost_drivers');
    });

    it('migration 050 skips a view that has a metadata or jsonb column and revokes its grant; a missing view is skipped', async () => {
      await exec(`CREATE VIEW v_top_cost_drivers_bi AS SELECT ci_id, metadata FROM cmdb.dim_ci;
        GRANT SELECT ON v_top_cost_drivers_bi TO metabase_readonly`);
      await exec(migration050); // v_underutilized_resources does not exist: no error
      await denied('SELECT * FROM v_top_cost_drivers_bi');
    });

    const reloptions = async (view: string) =>
      (await exec(`SELECT reloptions::text AS o FROM pg_class WHERE oid = '${view}'::regclass`, 'query'))[0]['o'];

    // cmdb#318 review: security_barrier on the BI-granted views that have no LIMIT.
    it('051 sets security_barrier on every unbounded cost view', async () => {
      await exec(costViewDdl.join(';\n'));
      await exec(`ALTER VIEW v_underutilized_resources RESET (security_barrier)`);
      for (const view of barrierViews.filter(v => v !== 'v_underutilized_resources')) {
        await exec(`CREATE VIEW ${view} AS SELECT ci_id FROM cmdb.dim_ci`);
      }
      for (const view of barrierViews) expect(await reloptions(view)).toBeNull();
      await exec(migration051);
      for (const view of barrierViews) expect(await reloptions(view)).toBe('{security_barrier=true}');
      await exec(migration051); // idempotent
      // not in 051's list, but cost-analysis.sql creates it with the barrier too (052 replaced its LIMIT 20 with a
      // per-organization row_number() filter, which no longer blocks push-down by itself); 051 leaves that option alone
      expect(await reloptions('v_top_cost_drivers_bi')).toBe('{security_barrier=true}');
    });

    // cmdb#328 review: cost-analysis.sql itself must create every unbounded cost view WITH (security_barrier). 051 sets
    // the option too, but runs once; a re-run of cost-analysis.sql (CREATE OR REPLACE VIEW without the option resets it)
    // would silently drop it from a view that lost the clause. Run the whole file's view DDL and read each view back.
    const allCostViewDdl = splitStatements(read(`${viewsDir}/cost-analysis.sql`)).filter(s => /^CREATE (OR REPLACE )?VIEW\b/.test(s));
    // all nine: the eight 051 covers plus v_top_cost_drivers_bi, whose per-organization row_number() filter does not
    // block push-down, so cost-analysis.sql (not 051) gives it the barrier
    it.each([...barrierViews, 'v_top_cost_drivers_bi'])('cost-analysis.sql creates %s with security_barrier', async view => {
      await exec(allCostViewDdl.join(';\n'));
      expect(await reloptions(view)).toBe('{security_barrier=true}');
    });

    // The barrier's effect: a predicate the BI user supplies must not run on rows the view filters out.
    it('a BI predicate cannot reach a CI the view excludes once the view has security_barrier', async () => {
      await exec(`CREATE FUNCTION leak(text) RETURNS boolean LANGUAGE plpgsql COST 0.0001 AS $$
        BEGIN IF $1 = 'hidden-inactive' THEN RAISE EXCEPTION 'leaked %', $1; END IF; RETURN true; END $$;
        INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, tbm_attributes, bsm_attributes, metadata)
        VALUES ('hidden', 'hidden-inactive', 'server', 'inactive', 'production', true, '{"monthly_cost": 5}', '{}',
                '{"utilization_pct": 10}')`);
      try {
        const sql = 'SELECT ci_id FROM v_underutilized_resources WHERE leak(ci_name)';
        await exec(costViewDdl.join(';\n'));
        await exec('GRANT SELECT ON v_underutilized_resources TO metabase_readonly');
        expect((await asBi(sql)).map(r => r['ci_id'])).toEqual(['ci-100']);
        await exec('ALTER VIEW v_underutilized_resources RESET (security_barrier)'); // the state before 051
        await expect(asBi(sql)).rejects.toThrow(/leaked hidden-inactive/);
        await exec(migration051);
        expect((await asBi(sql)).map(r => r['ci_id'])).toEqual(['ci-100']);
      } finally {
        await exec(`DELETE FROM cmdb.dim_ci WHERE ci_id = 'hidden'; DROP FUNCTION leak(text)`);
      }
    });

    // cmdb#318 review (info): the shape guard refuses json/jsonb carried by a domain, array or composite type, and a
    // view not owned by the owner of cmdb.dim_ci. The same rule runs in 051, metabase-init.sql and cost-analysis.sql.
    const costGuard = costStatements.filter(s => /^DO\b/.test(s)).join(';\n');
    const guards: [string, string][] = [['migration 051', migration051], ['metabase-init.sql', biSetup], ['cost-analysis.sql', costGuard]];
    describe.each(guards)('%s shape guard', (_name, run) => {
      it.each([
        ['a domain over jsonb', 'SELECT ci_id, metadata::dj AS x FROM cmdb.dim_ci'],
        ['an array of a domain over jsonb', 'SELECT ci_id, ARRAY[metadata::dj] AS x FROM cmdb.dim_ci'],
        ['a composite with a domain over jsonb', 'SELECT ci_id, ROW(1, metadata::dj)::cj AS x FROM cmdb.dim_ci'],
        ['a jsonb column under another name', 'SELECT ci_id, tbm_attributes AS x FROM cmdb.dim_ci'],
        ['a column named Metadata', 'SELECT ci_id, ci_name AS "Metadata" FROM cmdb.dim_ci'],
      ])('refuses %s and removes its grant', async (_shape, select) => {
        await exec(`CREATE DOMAIN dj AS jsonb; CREATE TYPE cj AS (a int, b dj)`);
        await exec(`CREATE VIEW v_underutilized_resources AS ${select};
          GRANT SELECT ON v_underutilized_resources TO metabase_readonly`);
        await exec(run);
        await denied('SELECT * FROM v_underutilized_resources');
      });

      it('refuses a view owned by another role, and still grants a bounded view owned by the dim_ci owner', async () => {
        await exec(`CREATE VIEW v_underutilized_resources AS SELECT ci_id FROM cmdb.dim_ci;
          GRANT SELECT ON v_underutilized_resources TO metabase_readonly`);
        await exec(run);
        expect(await asBi('SELECT ci_id FROM v_underutilized_resources LIMIT 1')).toHaveLength(1);
        await exec('CREATE ROLE other_owner');
        try {
          await exec('ALTER VIEW v_underutilized_resources OWNER TO other_owner');
          await exec(run);
          await denied('SELECT * FROM v_underutilized_resources');
        } finally {
          await exec('DROP OWNED BY other_owner; DROP ROLE other_owner');
        }
      });
    });

    const currentDatabase = async () => (await exec('SELECT current_database() AS d', 'query'))[0]['d'] as string;
    const biHasTemporary = async () => (await exec(
      `SELECT has_database_privilege('metabase_readonly', current_database(), 'TEMPORARY') AS t`, 'query'))[0]['t'];
    // Model a BI role that holds TEMPORARY itself (an older bootstrap); the PUBLIC grant is revoked so the role's own
    // grant is the only path, and put back afterwards for the tests that follow.
    const withOwnTemporaryGrant = async (run: (database: string) => Promise<void>) => {
      const database = await currentDatabase();
      await exec(`GRANT TEMPORARY ON DATABASE ${database} TO metabase_readonly;
        REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
      try {
        expect(await biHasTemporary()).toBe(true);
        await run(database);
      } finally {
        await exec(`GRANT TEMPORARY ON DATABASE ${database} TO PUBLIC; REVOKE TEMPORARY ON DATABASE ${database} FROM metabase_readonly`);
      }
    };

    it('051 removes a TEMPORARY grant made to the BI role (the PUBLIC grant is separate)', () =>
      withOwnTemporaryGrant(async () => {
        await exec(migration051);
        expect(await biHasTemporary()).toBe(false);
        await denied('CREATE TEMP TABLE bi_probe (i int)');
      }));

    // Run EVERY statement of metabase-init.sql that applies to the cmdb database (everything after its `\c cmdb`), in
    // file order, so a TEMPORARY grant anywhere in that section fails this test. The file names the production
    // database; it is swapped for this one. Only two statements are skipped: CREATE USER (the role already exists
    // here) and the metabase-database COMMENT (no such database here). The outcome is read back from the privilege
    // system, not from the statement text.
    it('metabase-init.sql leaves the BI role without TEMPORARY on the database', () =>
      withOwnTemporaryGrant(async database => {
        const marker = '\\c cmdb\n';
        expect(initSql.split(marker)).toHaveLength(2);
        const all = splitStatements(initSql.slice(initSql.indexOf(marker) + marker.length));
        const notHere = (s: string) => /^CREATE USER metabase_readonly\b/.test(s) || /^COMMENT ON DATABASE metabase\b/.test(s);
        expect(all.filter(notHere)).toHaveLength(2);
        const statements = all.filter(s => !notHere(s));
        expect(statements.length).toBeGreaterThanOrEqual(10);
        for (const statement of statements) await exec(statement.replace(/ON DATABASE cmdb\b/g, `ON DATABASE ${database}`));
        expect(await biHasTemporary()).toBe(false);
        await denied('CREATE TEMP TABLE bi_probe (i int)');
      }));

    // 051 warns and skips a barrier view that another role owns (the owner could redefine it), and carries on.
    it('051 skips security_barrier on a cost view owned by another role, sets it on the rest, and does not fail', async () => {
      await exec(costViewDdl.join(';\n'));
      await exec(`ALTER VIEW v_underutilized_resources RESET (security_barrier)`);
      for (const view of barrierViews.filter(v => v !== 'v_underutilized_resources')) {
        await exec(`CREATE VIEW ${view} AS SELECT ci_id FROM cmdb.dim_ci`);
      }
      await exec('CREATE ROLE other_owner');
      try {
        await exec('ALTER VIEW v_cost_by_tower OWNER TO other_owner');
        await exec(migration051);
        expect(await reloptions('v_cost_by_tower')).toBeNull();
        for (const view of barrierViews.filter(v => v !== 'v_cost_by_tower')) {
          expect(await reloptions(view)).toBe('{security_barrier=true}');
        }
        // the fix: hand the view back to the owner of cmdb.dim_ci and run 051 again
        await exec('ALTER VIEW v_cost_by_tower OWNER TO CURRENT_USER');
        await exec(migration051);
        expect(await reloptions('v_cost_by_tower')).toBe('{security_barrier=true}');
      } finally {
        await exec('DROP OWNED BY other_owner; DROP ROLE other_owner');
      }
    });
  });
});
