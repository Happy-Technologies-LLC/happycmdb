// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import neo4j, { Driver, Session } from 'neo4j-driver';
import { Pool } from 'pg';
import {
  backfillBusinessServiceOrganizations, type BackfillSummary, type GraphSession, type SqlClient,
} from '../../../packages/api-server/src/scripts/backfill-business-service-organization';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CUTOVER = '2026-10-01T00:00:00Z';
const options = { apply: false, createdBefore: CUTOVER, writerTimezone: 'Etc/UTC' };
const ids = ['backfill-control-a', 'backfill-control-b'];

let pool: Pool;
let driver: Driver;
let graph: Session;
let pg: SqlClient;

beforeAll(async () => {
  pool = new Pool({
    host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
    database: process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'],
  });
  driver = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
  graph = driver.session();
  pg = {
    query: (sql, params) => pool.query(sql, params),
    transaction: async callback => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  await pg.query(`INSERT INTO dim_business_services
    (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id, created_at)
    VALUES ($1, 'A', 'application', 'application', 'high', 'active', $3, '2026-09-01 00:00:00'),
           ($2, 'B', 'application', 'application', 'high', 'active', $4, '2026-09-01 00:00:00')`, [...ids, ORG_A, ORG_B]);
});

afterAll(async () => {
  await graph?.run('MATCH (bs:BusinessService) WHERE bs.id IN $ids DETACH DELETE bs', { ids });
  await pg?.query('DELETE FROM dim_business_services WHERE service_id = ANY($1::text[])', [ids]);
  await graph?.close();
  await driver?.close();
  await pool?.end();
});

beforeEach(async () => {
  await pg.query('UPDATE dim_business_services SET organization_id = CASE WHEN service_id = $1 THEN $3::uuid ELSE $4::uuid END WHERE service_id = ANY($2::text[])', [ids[0], ids, ORG_A, ORG_B]);
  await graph.run('MATCH (bs:BusinessService) WHERE bs.id IN $ids DETACH DELETE bs', { ids });
  await graph.run('UNWIND $ids AS id CREATE (:BusinessService {id: id})', { ids });
});

async function review(): Promise<BackfillSummary> {
  const summary = await backfillBusinessServiceOrganizations(pg, graph, options);
  expect(summary.plan?.targets.map(t => t.serviceId)).toEqual(ids);
  return summary;
}

async function currentOwners(): Promise<Array<{ id: string; org: string | null }>> {
  const result = await graph.run('MATCH (bs:BusinessService) WHERE bs.id IN $ids RETURN bs.id AS id, bs.organization_id AS org ORDER BY id', { ids });
  return result.records.map(record => ({ id: record.get('id') as string, org: record.get('org') as string | null }));
}

test('Postgres owner drift between review and apply cannot authorize either org write', async () => {
  const reviewed = await review();
  await pg.query('UPDATE dim_business_services SET organization_id = $1 WHERE service_id = $2', [ORG_B, ids[0]]);
  await expect(backfillBusinessServiceOrganizations(pg, graph, {
    ...options, apply: true, reviewed, sha256: reviewed.plan_sha256,
  })).rejects.toThrow(/Postgres ownership\/cutover drift/);
  expect(await currentOwners()).toEqual(ids.map(id => ({ id, org: null })));
});

test('Neo4j replacement after review rolls back the other org write', async () => {
  const reviewed = await review();
  await graph.run('MATCH (bs:BusinessService {id: $id}) DETACH DELETE bs', { id: ids[1] });
  await graph.run('CREATE (:BusinessService {id: $id})', { id: ids[1] });
  const replacement = await graph.run('MATCH (bs:BusinessService {id: $id}) RETURN elementId(bs) AS elementId', { id: ids[1] });
  expect(replacement.records[0]!.get('elementId')).not.toBe(reviewed.plan!.targets[1]!.elementId);
  await expect(backfillBusinessServiceOrganizations(pg, graph, {
    ...options, apply: true, reviewed, sha256: reviewed.plan_sha256,
  })).rejects.toThrow(/Neo4j identity\/organization drift/);
  expect(await currentOwners()).toEqual(ids.map(id => ({ id, org: null })));
});

test('an ownership update waits while reviewed graph writes hold PostgreSQL share locks', async () => {
  const reviewed = await review();
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const gatedGraph: GraphSession = {
    run: graph.run.bind(graph),
    executeWrite: async callback => {
      enter();
      await gate;
      return graph.executeWrite(callback);
    },
  };
  const applying = backfillBusinessServiceOrganizations(pg, gatedGraph, {
    ...options, apply: true, reviewed, sha256: reviewed.plan_sha256,
  });
  await Promise.race([entered, applying.then(() => { throw new Error('apply exited before graph write'); })]);
  const updater = await pool.connect();
  try {
    // PostgreSQL's own lock timeout tests the real row lock without a wall-clock sleep.
    await updater.query("SET lock_timeout = '150ms'");
    await expect(updater.query(
      'UPDATE dim_business_services SET organization_id = $1 WHERE service_id = $2', [ORG_B, ids[0]]
    )).rejects.toMatchObject({ code: '55P03' });
    release();
    await applying;
    expect(await currentOwners()).toEqual([
      { id: ids[0]!, org: ORG_A }, { id: ids[1]!, org: ORG_B },
    ]);
  } finally {
    release();
    try {
      await applying;
    } finally {
      updater.release();
    }
  }
});
