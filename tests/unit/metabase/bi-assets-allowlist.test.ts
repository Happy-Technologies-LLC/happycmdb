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
    const denied = (sql: string) => expect(asBi(sql)).rejects.toThrow(/permission denied/);

    beforeAll(async () => {
      expect(costStatements.length).toBeGreaterThanOrEqual(7);
      expect(biSetup).toContain('DO $bi$');
      await exec(`CREATE ROLE metabase_readonly;
        CREATE SCHEMA cmdb;
        CREATE TABLE cmdb.dim_ci (ci_key serial, ci_id text, ci_name text, ci_type text, ci_status text, environment text,
          is_current boolean, tbm_attributes jsonb, bsm_attributes jsonb, metadata jsonb, updated_at timestamptz DEFAULT now());
        INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, tbm_attributes, bsm_attributes, metadata)
        VALUES ${[
          ...Array.from({ length: 25 }, (_, i) => row(i, 1000 + i, 90)), // 25 active, costed, well utilized
          row(100, 500, 40), // underutilized: 40% of $500
          row(101, 500, 'n/a'), // non-numeric utilization must not raise
          row(102, 500, 60),
          row(103, 0, 10), // no cost
        ].join(',')}`);
    }, 60000);
    beforeEach(async () => { await exec('DROP VIEW IF EXISTS v_top_cost_drivers, v_top_cost_drivers_bi, v_underutilized_resources CASCADE'); });
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
  });
});
