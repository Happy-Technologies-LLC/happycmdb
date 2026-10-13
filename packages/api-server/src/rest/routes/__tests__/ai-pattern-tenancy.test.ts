// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PatternAnalyzer, PatternStorageService, PatternWorkflow } from '@cmdb/ai-discovery';

const db = new PGlite();
const sql = {
  query: (text: string, values?: unknown[]) => db.query(text, values),
  getClient: async () => ({ query: (text: string, values?: unknown[]) => db.query(text, values), release: () => undefined }),
};
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => sql,
  getRedisClient: () => ({ get: jest.fn(), setex: jest.fn(), del: jest.fn() }),
}));
jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => {
    const { AuthMiddleware } = require('../../../middleware/auth.middleware');
    return new AuthMiddleware({
      verifyToken: async (token: string) => {
        const organizationId = token === 'invalid' ? 'not-a-uuid' : token;
        if (organizationId !== 'not-a-uuid' &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
          throw new Error('Invalid test credential');
        }
        return { _userId: 'verified-user', _role: 'admin', _organizationId: organizationId };
      },
    }, { apiKeys: { headerName: 'x-api-key' } });
  },
}));

import { aiPatternRoutes } from '../ai-pattern.routes';
const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const app = express();
app.use(express.json());
app.use('/api/v1', require('../../../auth/auth-bootstrap').getAuthMiddleware().authenticate());
app.use('/api/v1/ai', aiPatternRoutes);
const get = (org: string, path: string) => request(app).get(`/api/v1/ai${path}`).set('authorization', `Bearer ${org}`);
const post = (org: string, path: string, body = {}) => request(app).post(`/api/v1/ai${path}`).set('authorization', `Bearer ${org}`).send(body);

beforeAll(async () => {
  await db.exec(`CREATE TABLE ai_discovery_sessions (
    session_id text PRIMARY KEY, id text, organization_id uuid, target_host text,
    target_port integer, status text, started_at timestamp, completed_at timestamp,
    ai_model text, tool_calls jsonb, discovered_cis jsonb, estimated_cost numeric,
    confidence_score float, scan_result jsonb, duration_ms integer, total_tokens integer,
    prompt_tokens integer, completion_tokens integer, ai_reasoning text,
    pattern_matched text, error_message text, retry_count integer, created_at timestamp
  );
  INSERT INTO ai_discovery_sessions (session_id, id, organization_id, target_host, target_port, status, started_at, ai_model, tool_calls)
  VALUES ('owned', 'owned', '${A}', 'private-a', 22, 'completed', now(), 'model', '[]'),
    ('foreign', 'foreign', '${B}', 'private-b', 22, 'completed', now(), 'model', '[]'),
    ('legacy', 'legacy', NULL, 'unknown', 22, 'completed', now(), 'model', '[]');
  CREATE TABLE ai_discovery_patterns (
    pattern_id text PRIMARY KEY, organization_id uuid, status text,
    name text, version text, category text, description text, detection_code text, discovery_code text,
    author text, confidence_score float, usage_count integer, is_active boolean DEFAULT false, created_at timestamp,
    id text, license text, success_count integer, failure_count integer,
    avg_execution_time_ms integer, learned_from_sessions jsonb, ai_model text,
    registry_url text, community_upvotes integer, community_downvotes integer,
    test_cases jsonb, updated_at timestamp, approved_at timestamp, approved_by text
  );
  INSERT INTO ai_discovery_patterns (pattern_id, organization_id, status, name, version, category, detection_code, discovery_code, author, confidence_score, usage_count, created_at)
  VALUES ('owned', '${A}', 'draft', 'private-a-pattern', '1', 'test', 'invalid', 'invalid', 'author-a', 0.9, 1, now()),
    ('foreign', '${B}', 'review', 'private-b-pattern', '1', 'test', 'invalid', 'invalid', 'author-b', 0.8, 1, now()),
    ('legacy', NULL, 'active', 'unknown-pattern', '1', 'test', 'invalid', 'invalid', 'unknown', 0.7, 1, now());
  CREATE TABLE ai_pattern_review_history (
    pattern_id text, action text, performed_by text, comment text, created_at timestamp
  );
  INSERT INTO ai_pattern_review_history VALUES
    ('owned', 'submit', 'author-a', 'private-a-note', now()),
    ('foreign', 'approve', 'author-b', 'private-b-note', now()),
    ('legacy', 'approve', 'unknown', 'unknown-note', now());
  CREATE TABLE ai_pattern_usage (
    pattern_id text, session_id text, success boolean, execution_time_ms integer,
    confidence_score float, error_message text, timestamp timestamp
  );
  INSERT INTO ai_pattern_usage VALUES
    ('owned', 'owned', true, 10, 0.9, null, now()),
    ('owned', 'foreign', true, 11, 0.8, null, now()),
    ('owned', 'legacy', true, 12, 0.7, null, now()),
    ('foreign', 'foreign', true, 13, 0.8, null, now());`);
  await db.query(`UPDATE ai_discovery_patterns SET is_active = true WHERE pattern_id = 'legacy'`);
});
afterAll(async () => { await db.close(); });

test('mounted sessions isolate tenant rows, preserve owned reads, and hide foreign/legacy IDs before analysis', async () => {
  const owned = await get(A, '/sessions');
  expect(owned.status).toBe(200);
  expect(owned.body.data.map((row: { sessionId: string }) => row.sessionId)).toEqual(['owned']);
  expect((await get(B, '/sessions')).body.data.map((row: { sessionId: string }) => row.sessionId)).toEqual(['foreign']);
  expect((await get(A, '/sessions/owned')).body.data.targetHost).toBe('private-a');
  for (const id of ['foreign', 'legacy']) {
    expect((await get(A, `/sessions/${id}`)).body).toEqual((await get(A, '/sessions/missing')).body);
    expect((await post(A, `/sessions/${id}/analyze`)).body).toEqual((await post(A, '/sessions/missing/analyze')).body);
  }
  expect((await get(A, '/sessions?search=private-b')).body.data).toEqual([]);
  expect((await get(A, '/sessions?includeSynthetic=true')).body.data).toHaveLength(1);
  expect((await post(A, '/sessions/owned/analyze')).status).toBe(200);
  expect((await get('invalid', '/sessions')).status).toBe(403);
});

test('mounted pattern reads and usage hide foreign and unattributed rows, including joined hosts', async () => {
  expect((await get(A, '/patterns')).body.data.map((row: { patternId: string }) => row.patternId)).toEqual(['owned']);
  expect((await get(B, '/patterns')).body.data.map((row: { patternId: string }) => row.patternId)).toEqual(['foreign']);
  expect((await get(A, '/patterns/owned')).body.data.name).toBe('private-a-pattern');
  expect((await get(A, '/patterns/owned/history')).body.data[0].comment).toBe('private-a-note');
  expect((await post(A, '/patterns/owned/validate')).status).toBe(200);
  const usage = await get(A, '/patterns/owned/usage');
  expect(usage.status).toBe(200);
  expect(usage.body.data.map((row: { matchedHost: string }) => row.matchedHost)).toEqual(['private-a']);
  for (const path of ['/patterns/foreign', '/patterns/legacy']) {
    expect((await get(A, path)).body).toEqual((await get(A, '/patterns/missing')).body);
    for (const suffix of ['/usage', '/history']) {
      expect((await get(A, path + suffix)).body).toEqual((await get(A, '/patterns/missing' + suffix)).body);
    }
    expect((await post(A, path + '/validate')).body).toEqual((await post(A, '/patterns/missing/validate')).body);
  }
  expect((await get(A, '/patterns?search=private-b')).body.data).toEqual([]);
});

test('mounted cost and learning aggregates exclude foreign and NULL sessions, usage, patterns and approvals', async () => {
  const cost = await get(A, '/analytics/cost');
  expect(cost.status).toBe(200);
  expect(cost.body.data.totalSessions).toBe(1);
  expect(cost.body.data.savingsFromPatterns.patternHits).toBe(1);
  expect(cost.body.data.costByModel.map((row: { aiModel: string }) => row.aiModel)).toEqual(['model']);
  const learning = await get(A, '/analytics/learning');
  expect(learning.status).toBe(200);
  expect(learning.body.data).toMatchObject({ totalPatterns: 1, totalSessions: 1, pendingReview: 0, manualApproved: 0 });
  expect((await get(B, '/analytics/learning')).body.data).toMatchObject({ totalPatterns: 1, totalSessions: 1, pendingReview: 1, manualApproved: 1 });
  const empty = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
  expect((await get(empty, '/analytics/cost')).body.data).toMatchObject({ totalCost: 0, totalSessions: 0, savingsFromPatterns: { patternHits: 0 } });
  expect((await get(empty, '/analytics/learning')).body.data).toMatchObject({ totalPatterns: 0, totalSessions: 0, manualApproved: 0 });
});

test('analysis builds candidates from only the caller organization despite matching foreign traces', async () => {
  const calls = JSON.stringify([
    { toolName: 'scan', success: true, output: { port: 22 } },
    { toolName: 'probe', success: true, output: { service: 'ssh' } },
  ]);
  await db.query(`UPDATE ai_discovery_sessions SET confidence_score = 0.95, tool_calls = $1 WHERE session_id = 'owned'`, [calls]);
  for (const [id, org] of [['own-2', A], ['own-3', A], ['other-2', B], ['other-3', B], ['unknown-2', null]] as const) {
    await db.query(`INSERT INTO ai_discovery_sessions
      (session_id, id, organization_id, target_host, target_port, status, started_at, ai_model, tool_calls, confidence_score)
      VALUES ($1, $1, $2, $1, 22, 'completed', now(), 'model', $3, 0.95)`,
    [id, org, calls]);
  }
  const response = await post(A, '/sessions/owned/analyze');
  expect(response.status).toBe(200);
  expect(response.body.data.isPattern).toBe(true);
  expect(response.body.data.candidate.signature.sessions.sort()).toEqual(['own-2', 'own-3', 'owned']);
  expect((await post(B, '/sessions/owned/analyze')).status).toBe(404);
  const session = (await get(A, '/sessions/owned')).body.data;
  const analyzer = new PatternAnalyzer();
  expect((await analyzer.analyzeSession(session, A)).candidate?.signature.sessions.sort())
    .toEqual(['own-2', 'own-3', 'owned']);
  await expect(analyzer.analyzeSession(session, '')).rejects.toThrow('Organization required');
});

test('tenant admin cannot write shared patterns through any mounted lifecycle route or storage/workflow bypass', async () => {
  const paths: Array<[string, string, object]> = [
    ['post', '/patterns/compile', {}], ['delete', '/patterns/owned', {}],
    ['post', '/patterns/owned/submit', {}], ['post', '/patterns/owned/approve', {}],
    ['post', '/patterns/owned/reject', { reason: 'no' }],
    ['post', '/patterns/owned/activate', {}], ['post', '/patterns/owned/deactivate', {}],
  ];
  for (const [method, path, body] of paths) {
    const response = await request(app)[method as 'post'](`/api/v1/ai${path}`).set('authorization', `Bearer ${A}`).send(body);
    expect(response.status).toBe(403);
  }
  for (const path of ['/patterns/foreign/approve', '/patterns/legacy/deactivate', '/patterns/forged/submit', '/patterns/missing/activate']) {
    expect((await post(B, path)).status).toBe(403);
  }
  const storage = new PatternStorageService();
  const workflow = new PatternWorkflow(storage);
  await expect(storage.savePattern({} as never)).rejects.toThrow('Global pattern writes are unavailable');
  await expect(storage.deletePattern('owned')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(storage.updatePattern('owned', { status: 'active' })).rejects.toThrow('Global pattern writes are unavailable');
  await expect(storage.transitionPattern('owned', { status: 'active' }, 'activate', 'admin')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(storage.recordReviewAction('owned', 'approve', 'admin')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.compileAndSubmitPatterns()).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.approvePattern('owned', 'admin')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.submitForReview('owned', 'admin')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.rejectPattern('foreign', 'admin', 'reason')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.activatePattern('legacy', 'admin')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.deactivatePattern('legacy', 'admin')).rejects.toThrow('Global pattern writes are unavailable');
  await expect(workflow.autoApproveIfEligible('foreign')).rejects.toThrow('Global pattern writes are unavailable');
  expect((await db.query('SELECT pattern_id, status FROM ai_discovery_patterns ORDER BY pattern_id')).rows)
    .toEqual([{ pattern_id: 'foreign', status: 'review' }, { pattern_id: 'legacy', status: 'active' }, { pattern_id: 'owned', status: 'draft' }]);
});

test('internal matcher telemetry still creates synthetic session and usage without tenant lifecycle authority', async () => {
  const storage = new PatternStorageService();
  await storage.createExecutionSession('synthetic-internal', 'owned', {
    targetHost: 'matcher-internal', targetPort: 22,
  } as never, 'completed', 12);
  await storage.recordUsage('owned', 'synthetic-internal', true, 12, 0.9);
  expect((await db.query(`SELECT s.ai_model, s.organization_id, u.success
    FROM ai_discovery_sessions s JOIN ai_pattern_usage u ON u.session_id = s.session_id
    WHERE s.session_id = 'synthetic-internal'`)).rows).toEqual([
    { ai_model: 'pattern-matcher', organization_id: null, success: true },
  ]);
  expect((await get(A, '/sessions?includeSynthetic=true')).body.data
    .some((row: { sessionId: string }) => row.sessionId === 'synthetic-internal')).toBe(false);
});

test('matcher authoritative active-pattern load remains independent of tenant HTTP reads', async () => {
  const storage = new PatternStorageService();
  expect((await storage.loadPatterns(true)).map(pattern => pattern.patternId)).toEqual(['legacy']);
  expect((await get(A, '/patterns/legacy')).status).toBe(404);
});

test('nullable provenance migration and manual rollback preserve legacy data and reapply cleanly', async () => {
  const scratch = new PGlite();
  const migrations = resolve(__dirname, '../../../../../database/src/postgres/migrations');
  const forward = readFileSync(resolve(migrations, '027_ai_session_provenance.sql'), 'utf8');
  const rollback = readFileSync(resolve(migrations, 'rollback/027_ai_session_provenance.down.sql'), 'utf8');
  try {
    await scratch.exec(`CREATE SCHEMA cmdb;
      CREATE TABLE cmdb.schema_migrations (migration_name text);
      CREATE TABLE ai_discovery_sessions (session_id text);
      CREATE TABLE ai_discovery_patterns (pattern_id text);
      INSERT INTO ai_discovery_sessions VALUES ('legacy');
      INSERT INTO ai_discovery_patterns VALUES ('legacy');`);
    await scratch.exec(`BEGIN; ${forward} INSERT INTO cmdb.schema_migrations VALUES ('027_ai_session_provenance.sql'); COMMIT;`);
    expect((await scratch.query('SELECT organization_id FROM ai_discovery_sessions')).rows).toEqual([{ organization_id: null }]);
    expect((await scratch.query('SELECT organization_id FROM ai_discovery_patterns')).rows).toEqual([{ organization_id: null }]);
    await scratch.exec(rollback);
    expect((await scratch.query('SELECT * FROM cmdb.schema_migrations')).rows).toEqual([]);
    expect((await scratch.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('ai_discovery_sessions', 'ai_discovery_patterns')
        AND column_name='organization_id'`)).rows).toEqual([]);
    await scratch.exec(`BEGIN; ${forward} INSERT INTO cmdb.schema_migrations VALUES ('027_ai_session_provenance.sql'); COMMIT;`);
    expect((await scratch.query('SELECT session_id, organization_id FROM ai_discovery_sessions')).rows)
      .toEqual([{ session_id: 'legacy', organization_id: null }]);
    expect((await scratch.query('SELECT pattern_id, organization_id FROM ai_discovery_patterns')).rows)
      .toEqual([{ pattern_id: 'legacy', organization_id: null }]);
  } finally {
    await scratch.close();
  }
});
