// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration 009_business_service_views_org_scope: v_business_service_health
 * and v_tbm_tower_summary expose organization_id and use incident-weighted
 * MTTR; its manual rollback restores the 001 definitions.
 *
 * SQL is executed by PGlite hosted in a forked child process
 * (fixtures/pglite-host.cjs). Schema, in production order: the CREATE TABLE
 * blocks and the two views (with their GRANT / COMMENT) read verbatim from
 * 001_complete_schema.sql, then 008 and 009 applied verbatim. PGlite has no
 * TimescaleDB, so the fact tables are plain tables.
 *
 * Readers query the views the way an org-scoped caller must:
 * WHERE organization_id = <token _organizationId>.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { getMigrationStatus } from '../../../../../database/src/postgres/migrator';
import type { PostgresClient } from '../../../../../database/src/postgres/client';

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const db = {
  exec: (sql: string) => send('exec', sql),
  rows: <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>,
};

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');
const UP_008 = read('008_business_service_organization_scope.sql');
const DOWN_008 = read('rollback/008_business_service_organization_scope.down.sql');
const UP_009 = '009_business_service_views_org_scope.sql';
const DOWN_009 = 'rollback/009_business_service_views_org_scope.down.sql';

const TABLES = [
  'dim_business_services',
  'business_service_dependencies',
  'ci_business_service_mappings',
  'fact_business_service_incidents',
  'fact_business_service_changes',
];
const VIEWS = ['v_business_service_health', 'v_tbm_tower_summary'];

// The pre-009 state exactly as 001 creates it: tables, then the two views
// with their GRANT and COMMENT statements.
function schema001(): string {
  const sql = read('001_complete_schema.sql');
  const block = (pattern: string, what: string) => {
    const match = sql.match(new RegExp(pattern));
    if (!match) throw new Error(`${what} not found in 001_complete_schema.sql`);
    return match[0];
  };
  return [
    ...TABLES.map(t => block(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`, `DDL for ${t}`)),
    ...VIEWS.flatMap(v => [
      block(`CREATE OR REPLACE VIEW ${v} AS[\\s\\S]*?;\\n`, `view ${v}`),
      block(`GRANT SELECT ON ${v} TO PUBLIC;`, `grant on ${v}`),
      block(`COMMENT ON VIEW ${v} IS '[^']*';`, `comment on ${v}`),
    ]),
  ].join('\n');
}

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// bs-a-app has 3 mapping rows (ci-1 under two mapping types) and 2 change
// days: a join fan-out would multiply its incident sums by 6.
const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id) VALUES
  ('bs-a-app', 'A App', 'application', 'application', 'high', 'active', '${INTERNAL_ORG}'),
  ('bs-a-db', 'A Database', 'data', 'data', 'critical', 'active', '${INTERNAL_ORG}'),
  ('bs-b-app', 'B App', 'application', 'application', 'medium', 'active', '${ORG_B}'),
  ('bs-b-db', 'B Secret Database', 'data', 'data', 'critical', 'inactive', '${ORG_B}');
INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES
  ('ci-1', 'bs-a-app', 'hosts'), ('ci-1', 'bs-a-app', 'supports'), ('ci-2', 'bs-a-app', 'hosts'),
  ('ci-b', 'bs-b-app', 'hosts');
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
  ('bs-a-app', CURRENT_DATE - 1, 3, 30, 1),
  ('bs-b-app', CURRENT_DATE - 1, 900, 1000, 40);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count, failed_count) VALUES
  ('bs-a-app', CURRENT_DATE - 1, 4, 3, 1), ('bs-a-app', CURRENT_DATE - 2, 2, 2, 0),
  ('bs-b-app', CURRENT_DATE - 1, 8, 0, 8);`;

// #26's weighted-MTTR fixture: row average (10 + 100) / 2 = 55; weighted
// (1*10 + 9*100) / (1 + 9) = 91. The NULL-MTTR day counts as incidents but
// not toward MTTR; the day-45 row is outside the window.
const MTTR_FIXTURE = `
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
  ('bs-a-db', CURRENT_DATE - 2, 1, 10, 0),
  ('bs-a-db', CURRENT_DATE - 12, 9, 100, 1),
  ('bs-a-db', CURRENT_DATE - 14, 5, NULL, 0),
  ('bs-a-db', CURRENT_DATE - 45, 100, 1000, 4);`;

const health = (org: string) => db.rows<{ service_id: string }>(
  'SELECT * FROM v_business_service_health WHERE organization_id = $1 ORDER BY service_id', [org]
);
const towers = (org: string) => db.rows(
  'SELECT * FROM v_tbm_tower_summary WHERE organization_id = $1 ORDER BY tbm_tower', [org]
);

interface ViewState { viewname: string; definition: string; comment: string | null; acl: string | null }
const viewState = () => db.rows<ViewState>(
  `SELECT c.relname AS viewname, pg_get_viewdef(c.oid) AS definition,
     obj_description(c.oid, 'pg_class') AS comment, c.relacl::text AS acl
   FROM pg_class c WHERE c.relname = ANY($1) AND c.relkind = 'v' ORDER BY c.relname`, [VIEWS]
);

// getMigrationStatus only calls query(); unparameterised statements go over
// the simple protocol, which accepts several statements like node-postgres.
const migratorClient = {
  query: async (sql: string, params?: unknown[]) => ({
    rows: params?.length ? await send('query', sql, params) : await send('exec', sql),
  }),
} as unknown as PostgresClient;

let preViews: ViewState[] = [];

beforeAll(async () => {
  await db.exec(schema001());
  await db.exec(`BEGIN;\n${UP_008}\nCOMMIT;`);
  preViews = await viewState();
  await db.exec(`BEGIN;\n${read(UP_009)}\nCOMMIT;`);
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE;${SEED}`);
});

describe('v_business_service_health after 009', () => {
  it('returns only the caller organization\'s services, without join fan-out', async () => {
    expect(await health(INTERNAL_ORG)).toEqual([
      {
        organization_id: INTERNAL_ORG, service_id: 'bs-a-app', name: 'A App', service_classification: 'application',
        tbm_tower: 'application', business_criticality: 'high', operational_status: 'active',
        supported_ci_count: 2, incidents_last_30d: 3, sla_breaches_last_30d: 1, avg_mttr_minutes: 30,
        changes_last_30d: 6, failed_changes_last_30d: 1, health_status: 'degraded',
      },
      {
        organization_id: INTERNAL_ORG, service_id: 'bs-a-db', name: 'A Database', service_classification: 'data',
        tbm_tower: 'data', business_criticality: 'critical', operational_status: 'active',
        supported_ci_count: 0, incidents_last_30d: 0, sla_breaches_last_30d: 0, avg_mttr_minutes: null,
        changes_last_30d: 0, failed_changes_last_30d: 0, health_status: 'healthy',
      },
    ]);
    expect(await health(ORG_B)).toEqual([
      {
        organization_id: ORG_B, service_id: 'bs-b-app', name: 'B App', service_classification: 'application',
        tbm_tower: 'application', business_criticality: 'medium', operational_status: 'active',
        supported_ci_count: 1, incidents_last_30d: 900, sla_breaches_last_30d: 40, avg_mttr_minutes: 1000,
        changes_last_30d: 8, failed_changes_last_30d: 8, health_status: 'critical',
      },
      {
        organization_id: ORG_B, service_id: 'bs-b-db', name: 'B Secret Database', service_classification: 'data',
        tbm_tower: 'data', business_criticality: 'critical', operational_status: 'inactive',
        supported_ci_count: 0, incidents_last_30d: 0, sla_breaches_last_30d: 0, avg_mttr_minutes: null,
        changes_last_30d: 0, failed_changes_last_30d: 0, health_status: 'degraded',
      },
    ]);
  });

  it('weights MTTR by incident_count and skips days without a recorded MTTR (91, not 55)', async () => {
    await db.exec(MTTR_FIXTURE);
    const [row] = await db.rows(
      `SELECT incidents_last_30d, sla_breaches_last_30d, avg_mttr_minutes
       FROM v_business_service_health WHERE organization_id = $1 AND service_id = 'bs-a-db'`, [INTERNAL_ORG]
    );
    expect(row).toEqual({ incidents_last_30d: 15, sla_breaches_last_30d: 1, avg_mttr_minutes: 91 });
  });
});

describe('v_tbm_tower_summary after 009', () => {
  it('counts each organization\'s towers separately', async () => {
    expect(await towers(INTERNAL_ORG)).toEqual([
      { organization_id: INTERNAL_ORG, tbm_tower: 'application', service_count: 1, active_services: 1,
        critical_services: 0, high_criticality_services: 1 },
      { organization_id: INTERNAL_ORG, tbm_tower: 'data', service_count: 1, active_services: 1,
        critical_services: 1, high_criticality_services: 0 },
    ]);
    expect(await towers(ORG_B)).toEqual([
      { organization_id: ORG_B, tbm_tower: 'application', service_count: 1, active_services: 1,
        critical_services: 0, high_criticality_services: 0 },
      { organization_id: ORG_B, tbm_tower: 'data', service_count: 1, active_services: 0,
        critical_services: 1, high_criticality_services: 0 },
    ]);
  });
});

describe('migration 009 lifecycle', () => {
  it('is discovered by the migrator; its rollback is not', async () => {
    const names = (await getMigrationStatus(migratorClient, MIGRATIONS)).map(m => m._name);
    expect(names).toContain(UP_009);
    expect(names.filter(name => /down|rollback/.test(name))).toEqual([]);
  });

  it('is safe to re-run', async () => {
    await db.exec(`BEGIN;\n${read(UP_009)}\nCOMMIT;`);
    expect((await health(ORG_B)).map(r => r.service_id)).toEqual(['bs-b-app', 'bs-b-db']);
  });

  it('rollback restores the 001 view definitions, grants and comments, and un-records 009', async () => {
    await getMigrationStatus(migratorClient, MIGRATIONS); // ensures cmdb.schema_migrations
    await db.exec(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
      VALUES ('${UP_009}', 'x') ON CONFLICT DO NOTHING`);
    try {
      await db.exec(read(DOWN_009));
      expect(preViews).toHaveLength(2);
      expect(await viewState()).toEqual(preViews);
      expect(await db.rows(`SELECT 1 FROM cmdb.schema_migrations WHERE migration_name = $1`, [UP_009])).toEqual([]);
    } finally {
      await db.exec(`BEGIN;\n${read(UP_009)}\nCOMMIT;`);
    }
  });

  it('blocks rolling back 008 while 009 is applied; 009 then 008 rolls back cleanly', async () => {
    await expect(db.exec(DOWN_008)).rejects.toThrow(/depend/);
    await db.exec('ROLLBACK');
    expect(await db.rows(`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'dim_business_services' AND column_name = 'organization_id'`)).toHaveLength(1);
    try {
      await db.exec(read(DOWN_009));
      await db.exec(DOWN_008);
      expect(await db.rows(`SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dim_business_services' AND column_name = 'organization_id'`)).toEqual([]);
    } finally {
      await db.exec(`BEGIN;\n${UP_008}\n${read(UP_009)}\nCOMMIT;`);
    }
  });
});
