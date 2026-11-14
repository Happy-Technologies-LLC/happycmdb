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

/** Relations named after FROM / JOIN in a SQL text, schema-qualified; CTE names and EXTRACT(x FROM ...) excluded. */
function relations(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/EXTRACT\s*\(\s*\w+\s+FROM/gi, 'EXTRACT(');
  const ctes = new Set([...text.matchAll(/\b(\w+)\s+AS\s*\(/gi)].map(m => m[1].toLowerCase()));
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+("?[A-Za-z_]\w*"?(?:\.\w+)?)/gi)) {
    const name = m[1].replace(/"/g, '').toLowerCase();
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
  });

  it('reads the allowlist and finds the shipped dashboards and questions', () => {
    expect(allowlist().has('public.v_cost_by_tower')).toBe(true);
    expect(allowlist().has('public.itil_incidents')).toBe(false);
    expect(dashboards.length).toBeGreaterThanOrEqual(3);
    expect(assets.length).toBeGreaterThan(20);
  });

  it.each(assets.map(([file, sql]) => [file, sql.replace(/\s+/g, ' ').slice(0, 90), sql]))(
    '%s: %s', (_file, _label, sql) => {
      expect(unreadable(sql)).toEqual([]);
    });

  it('queries every relation it names, so none is silently skipped', () => {
    const all = new Set(assets.flatMap(([, sql]) => relations(sql)));
    expect(all.has('public.v_top_cost_drivers')).toBe(true);
    expect(all.has('public.v_underutilized_resources')).toBe(true);
  });

  describe('BI view files', () => {
    const files = readdirSync(join(root, viewsDir)).filter(f => f.endsWith('.sql')).sort();
    const statements = (file: string) => read(`${viewsDir}/${file}`).replace(/--[^\n]*/g, '').split(/;\s*\n/);

    it.each(files)('%s grants metabase_readonly only allowlisted views', file => {
      const granted = statements(file).flatMap(s => [...s.matchAll(/GRANT\s+SELECT\s+ON\s+([\w.]+)\s+TO\s+metabase_readonly/gi)])
        .map(m => (m[1].includes('.') ? m[1] : `public.${m[1]}`));
      expect(granted.length).toBeGreaterThan(0);
      expect(granted.filter(v => !allowlist().has(v))).toEqual([]);
    });

    it.each(files)('%s: no BI-granted view selects a whole metadata column', file => {
      const granted = new Set(statements(file).flatMap(s => [...s.matchAll(/GRANT\s+SELECT\s+ON\s+(\w+)\s+TO\s+metabase_readonly/gi)])
        .map(m => m[1]));
      const leaking = statements(file).flatMap(s => {
        const view = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(\w+)\s+AS/i.exec(s);
        // bare `metadata` / `ci.metadata`; `metadata->>'key'` extracts one scalar and is bounded
        return view && granted.has(view[1]) && /\b(?:\w+\.)?metadata\b(?!\s*->)/i.test(s) ? [view[1]] : [];
      });
      expect(leaking).toEqual([]);
    });
  });

  describe('v_top_cost_drivers and v_underutilized_resources as the BI role (PGlite)', () => {
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

    beforeAll(async () => {
      const file = read(`${viewsDir}/cost-analysis.sql`).replace(/--[^\n]*/g, '');
      const mine = file.split(/;\s*\n/).map(s => s.trim()).filter(s =>
        /^(DROP VIEW IF EXISTS|CREATE (OR REPLACE )?VIEW|COMMENT ON VIEW|GRANT SELECT ON) v_(top_cost_drivers|underutilized_resources)\b/.test(s));
      expect(mine.length).toBeGreaterThanOrEqual(5);
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
      await exec(`${mine.join(';\n')};`);
    }, 60000);
    afterAll(() => { host.kill(); });

    it('top cost drivers: BI can read the 20 most expensive CIs, with no metadata column and no secret value', async () => {
      const rows = await asBi('SELECT * FROM v_top_cost_drivers');
      expect(rows).toHaveLength(20);
      expect(rows[0]['ci_id']).toBe('ci-24');
      expect(Object.keys(rows[0])).not.toContain('metadata');
      expect(JSON.stringify(rows)).not.toContain(secret);
    });

    it('underutilized resources: only numeric utilization below 50, with savings, and no metadata or secret', async () => {
      const rows = await asBi('SELECT * FROM v_underutilized_resources');
      expect(rows.map(r => r['ci_id'])).toEqual(['ci-100']);
      expect(Number(rows[0]['potential_savings'])).toBeCloseTo(300);
      expect(Object.keys(rows[0])).not.toContain('metadata');
      expect(JSON.stringify(rows)).not.toContain(secret);
    });

    it('the BI role still cannot read the raw dimension', async () => {
      await expect(asBi('SELECT metadata FROM cmdb.dim_ci')).rejects.toThrow(/permission denied/);
    });
  });
});
