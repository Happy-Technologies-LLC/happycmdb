// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Real Timescale/Postgres and Neo4j acceptance for HP1-S1; global setup
 * applies 001–031 and fails hard on 028–031. No live database is contacted. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import neo4j, { Driver } from 'neo4j-driver';
import { Pool } from 'pg';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let db: Pool;
let graph: Driver;

beforeAll(() => {
  db = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
    database: process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
  graph = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
});
afterAll(async () => { await db?.end(); await graph?.close(); });

// A rollback makes each case independent even under the shared CI database.
async function transaction(run: (query: (sql: string, values?: unknown[]) => Promise<any>) => Promise<void>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await run((sql, values) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

if (process.env['HP1_S1_BASELINE'] === '1') {
  it('fails before S1: the legacy writer runs but no org-isolated journal key exists', async () => {
    await transaction(async q => {
      await q(`INSERT INTO ci_change_history (ci_id, change_type, change_source)
        VALUES ('hp1-baseline', 'updated', 'kafka')`);
      const { rows } = await q(`SELECT to_regclass('public.ci_reconciliation_operations') AS journal`);
      expect(rows[0].journal).toBeNull();
      const indexes = await q(`SELECT count(*)::int AS n FROM pg_indexes
        WHERE indexname IN ('ci_source_lineage_org_key', 'ci_field_sources_org_key')`);
      expect(indexes.rows[0].n).toBe(0);
    });
  });
} else {

describe('HP1-S1 expand contract on actual Timescale hypertables', () => {
  it('keeps legacy ON CONFLICT writers, org-less inserts and conflict update/delete working', async () => {
    await transaction(async q => {
      for (let i = 0; i < 2; i++) {
        await q(`INSERT INTO ci_source_lineage (ci_id, source_name, source_id, confidence_score)
          VALUES ($1, 'hp1-old-source', 'instance', 90) ON CONFLICT (ci_id, source_name, source_id)
          DO UPDATE SET confidence_score = EXCLUDED.confidence_score`, [CI]);
        await q(`INSERT INTO ci_field_sources (ci_id, field_name, field_value, source_name)
          VALUES ($1, 'host', 'old', 'hp1-old-source') ON CONFLICT (ci_id, field_name)
          DO UPDATE SET field_value = EXCLUDED.field_value`, [CI]);
        await q(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at) VALUES ('hp1-old-ci', '{}', now())
          ON CONFLICT (ci_id) DO UPDATE SET factors = EXCLUDED.factors`);
        await q(`INSERT INTO source_authority (source_name, authority_score) VALUES ('hp1-old-source', 5)
          ON CONFLICT (source_name) DO UPDATE SET authority_score = EXCLUDED.authority_score`);
      }
      await q(`INSERT INTO ci_change_history (ci_id, change_type, change_source) VALUES ('hp1-old-ci', 'updated', 'kafka')`);
      await q(`INSERT INTO audit_log (actor, entity_type, entity_id, action)
        VALUES ('old', 'CI', 'hp1-old-ci', 'UPDATE')`);
      const { rows } = await q(`INSERT INTO reconciliation_conflicts (ci_id, conflict_type, source_data)
        VALUES ($1, 'field', '{}') RETURNING id`, [CI]);
      await q(`UPDATE reconciliation_conflicts SET status = 'resolved', resolution_data = '{}' WHERE id = $1`, [rows[0].id]);
      await q(`DELETE FROM reconciliation_conflicts WHERE id = $1`, [rows[0].id]);
      const legacy = await q(`SELECT organization_id FROM ci_change_history WHERE ci_id = 'hp1-old-ci'`);
      expect(legacy.rows[0].organization_id).toBeNull();
    });
  });

  it('isolates journal keys by org; preserves global legacy keys while adding scoped evidence keys', async () => {
    await transaction(async q => {
      const insert = (id: string, org: string) => q(`INSERT INTO ci_reconciliation_operations
        (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state, actor, epoch, lease_expires_at)
        VALUES ($1, $1, $2, 'shared-ci', 'api', 'update', true, 'pending', 'actor', 1, now())`, [id, org]);
      await insert('aaaaaaaa-0000-4000-8000-000000000001', A);
      await insert('aaaaaaaa-0000-4000-8000-000000000002', B);
      await expect(insert('aaaaaaaa-0000-4000-8000-000000000003', A)).rejects.toMatchObject({ code: '23505' });
    });
    await transaction(async q => {
      const insert = (org: string) => q(`INSERT INTO reconciliation_conflicts
        (ci_id, conflict_type, source_data, organization_id, field_name, source_name, source_id)
        VALUES ('ci_non_uuid', 'field', '{}', $1, 'host', 'hp1-source', 'instance')`, [org]);
      await insert(A); // S4, not S1, enforces detected_by on org-owned rows.
      await insert(B);
      await expect(insert(A)).rejects.toMatchObject({ code: '23505' });
    });
    const { rows } = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('ci_source_lineage_org_key', 'ci_field_sources_org_key', 'reconciliation_conflicts_pending_key') ORDER BY indexname`);
    expect(rows.map(row => row.indexname)).toEqual([
      'ci_field_sources_org_key', 'ci_source_lineage_org_key', 'reconciliation_conflicts_pending_key',
    ]);
    for (const table of ['ci_reconciliation_operations', 'ci_reconciliation_epochs']) {
      const { rows: acl } = await db.query(`SELECT count(*)::int AS grants FROM pg_class c,
        LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        WHERE c.oid = $1::regclass AND a.grantee = 0`, [table]);
      expect(acl[0].grants).toBe(0);
    }
  });

  it('counts only current non-backfilled service-owned CIs', async () => {
    await transaction(async q => {
      await q(`INSERT INTO dim_business_services
        (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id)
        VALUES ('hp1-s1-service', 'S1', 'application', 'application', 'high', 'active', $1)`, [A]);
      await q(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id, org_backfilled)
        VALUES ('hp1-s1-own', 'own', 'server', 'active', $1, false),
          ('hp1-s1-foreign', 'foreign', 'server', 'active', $2, false),
          ('hp1-s1-backfilled', 'backfilled', 'server', 'active', $1, true)`, [A, B]);
      await q(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES
        ('hp1-s1-own', 'hp1-s1-service', 'hosts'), ('hp1-s1-foreign', 'hp1-s1-service', 'hosts'),
        ('hp1-s1-backfilled', 'hp1-s1-service', 'hosts')`);
      const { rows } = await q(`SELECT supported_ci_count FROM v_business_service_health WHERE service_id = 'hp1-s1-service'`);
      expect(Number(rows[0].supported_ci_count)).toBe(1);
    });
  });
  it('accepts superseded JSON evidence without imposing S4 immutability', async () => {
    await transaction(async q => {
      const { rows } = await q(`INSERT INTO reconciliation_conflicts
        (ci_id, conflict_type, source_data, organization_id, incoming_json, status)
        VALUES ('ci_non_uuid', 'field', '{}', $1, '{"host":"new"}', 'superseded') RETURNING id`, [A]);
      await q(`UPDATE reconciliation_conflicts SET incoming_json = '{"host":"corrected"}' WHERE id = $1`, [rows[0].id]);
      const evidence = await q(`SELECT incoming_json->>'host' AS host, detected_by
        FROM reconciliation_conflicts WHERE id = $1`, [rows[0].id]);
      expect(evidence.rows).toEqual([{ host: 'corrected', detected_by: null }]);
      await q(`DELETE FROM reconciliation_conflicts WHERE id = $1`, [rows[0].id]);
    });
  });

  it('fresh initdb preserves old writers and matches migrated S1 column and index contracts', async () => {
    const database = 'hp1_s1_v3_parity';
    await db.query(`CREATE DATABASE ${database}`);
    const fresh = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
      database, user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
    try {
      await fresh.query(readFileSync(join(__dirname, '../../../infrastructure/scripts/init-postgres.sql'), 'utf8'));
      const tableNames = ['ci_change_history', 'ci_source_lineage', 'ci_field_sources',
        'reconciliation_conflicts', 'reconciliation_rules', 'source_authority',
        'baseline_snapshots', 'drift_detection_results', 'impact_analyses',
        'ci_criticality_scores', 'audit_log', 'ci_reconciliation_operations', 'ci_reconciliation_epochs'];
      const columns = `SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = ANY($1) AND column_name IN
            ('organization_id', 'correlation_id', 'last_correlation_id', 'value_json', 'ci_id',
             'incoming_json', 'detected_by', 'epoch') ORDER BY 1, 2`;
      const indexes = `SELECT tablename, indexname, regexp_replace(indexdef, ' ON [^ ]+ ', ' ON table ', 'g') AS definition
        FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1)
          AND indexname IN ('ci_source_lineage_org_key', 'ci_field_sources_org_key',
            'reconciliation_conflicts_pending_key', 'ci_reconciliation_operations_inflight',
            'ci_criticality_scores_org_ci_key') ORDER BY 1, 2`;
      expect((await fresh.query(columns, [tableNames])).rows).toEqual((await db.query(columns, [tableNames])).rows);
      expect((await fresh.query(indexes, [tableNames])).rows).toEqual((await db.query(indexes, [tableNames])).rows);
      await fresh.query(`INSERT INTO ci_source_lineage (ci_id, source_name, source_id) VALUES ($1, 'legacy', 'instance')
        ON CONFLICT (ci_id, source_name, source_id) DO UPDATE SET source_id = EXCLUDED.source_id`, [CI]);
      await fresh.query(`INSERT INTO reconciliation_conflicts
        (ci_id, conflict_type, source_data, status) VALUES ($1, 'field', '{}', 'superseded')`, [CI]);
      const down = readFileSync(join(__dirname,
        '../../../packages/database/src/postgres/migrations/rollback/029_reconciliation_conflict_identity_rules.down.sql'), 'utf8');
      await expect(fresh.query(down)).rejects.toThrow('029 down refused: superseded conflicts exist');
      await fresh.query('ROLLBACK');
      const { rows: stillTyped } = await fresh.query(`SELECT data_type FROM information_schema.columns
        WHERE table_name = 'reconciliation_conflicts' AND column_name = 'ci_id'`);
      expect(stillTyped[0].data_type).toBe('character varying');
    } finally {
      await fresh.end();
      await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
  });

});

it('Neo4j 004 rejects a duplicate op_id across distinct tenants', async () => {
  const session = graph.session();
  const migration = readFileSync(join(__dirname, '../../../packages/database/src/neo4j/migrations/004_reconciliation_op_fence.cypher'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n').trim();
  try {
    await session.run(migration);
    await session.run(`CREATE (:ReconciliationOp {op_id:'hp1-s1-proof', organization_id:$org})`, { org: A });
    await expect(session.run(`CREATE (:ReconciliationOp {op_id:'hp1-s1-proof', organization_id:$org})`, { org: B }))
      .rejects.toThrow();
  } finally {
    await session.run(`MATCH (o:ReconciliationOp {op_id:'hp1-s1-proof'}) DELETE o`);
    await session.close();
  }
});
}
