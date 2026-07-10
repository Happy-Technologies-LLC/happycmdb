// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test proving the audit_log hash chain against a real
 * throwaway Postgres database (cmdb_test). Gated on DATABASE_URL so it
 * never runs as part of the normal unit suite:
 *
 *   DATABASE_URL=postgres://throwaway:throwaway@localhost:55432/cmdb_test \
 *     npx jest --config jest.config.integration.js audit-chain
 */

import { Pool } from 'pg';
import { AuditService } from '../../../src/postgres/audit.service';

const DATABASE_URL = process.env['DATABASE_URL'];
process.env['AUDIT_CHAIN_KEY'] = process.env['AUDIT_CHAIN_KEY'] || 'throwaway-test-key-cmdb';
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('AuditService hash chain (cmdb_test)', () => {
  let pool: Pool;
  let auditService: AuditService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    await pool.query('DROP TABLE IF EXISTS audit_log');
    await pool.query('DROP TYPE IF EXISTS audit_action');
    await pool.query('DROP TYPE IF EXISTS audit_entity_type');
    await pool.query('DROP TYPE IF EXISTS audit_actor_type');

    await pool.query(`
      CREATE TYPE audit_action AS ENUM (
        'CREATE', 'UPDATE', 'DELETE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE', 'DISCOVERY_UPDATE'
      )
    `);
    await pool.query(`CREATE TYPE audit_entity_type AS ENUM ('CI', 'RELATIONSHIP')`);
    await pool.query(`CREATE TYPE audit_actor_type AS ENUM ('user', 'system', 'discovery')`);

    // Minimal equivalent of 001_complete_schema.sql's audit_log (sans
    // hypertable extras, which aren't relevant to the chain).
    await pool.query(`
      CREATE TABLE audit_log (
        id UUID DEFAULT gen_random_uuid(),
        entity_type audit_entity_type NOT NULL,
        entity_id VARCHAR(255) NOT NULL,
        action audit_action NOT NULL,
        actor VARCHAR(255) NOT NULL,
        actor_type audit_actor_type NOT NULL DEFAULT 'system',
        changes JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB DEFAULT '{}'::jsonb,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip_address INET,
        user_agent TEXT,
        PRIMARY KEY (id, timestamp)
      )
    `);

    // Additive migration under test: 003_audit_hash_chain.sql.
    await pool.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64)');
    await pool.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash VARCHAR(64)');

    auditService = new AuditService(pool);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS audit_log');
    await pool.query('DROP TYPE IF EXISTS audit_action');
    await pool.query('DROP TYPE IF EXISTS audit_entity_type');
    await pool.query('DROP TYPE IF EXISTS audit_actor_type');
    await pool.end();
  });

  it('chains three writes and verifies ok with checked=3', async () => {
    await auditService.logAudit({
      entity_type: 'CI',
      entity_id: 'ci-1',
      action: 'CREATE',
      actor: 'tester',
      actor_type: 'user',
      changes: [],
      metadata: { note: 'first' },
    });
    await auditService.logAudit({
      entity_type: 'CI',
      entity_id: 'ci-1',
      action: 'UPDATE',
      actor: 'tester',
      actor_type: 'user',
      changes: [{ field: 'name', old_value: 'a', new_value: 'b' }],
      metadata: { note: 'second' },
    });
    await auditService.logAudit({
      entity_type: 'RELATIONSHIP',
      entity_id: 'rel-1',
      action: 'RELATIONSHIP_ADD',
      actor: 'system',
      actor_type: 'system',
      changes: [],
    });

    const { rows } = await pool.query('SELECT id, entry_hash, prev_hash FROM audit_log');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => typeof r.entry_hash === 'string' && r.entry_hash.length > 0)).toBe(
      true
    );

    const verification = await auditService.verifyAuditChain();
    expect(verification.ok).toBe(true);
    expect(verification.checked).toBe(3);
  });

  it('detects tampering with reason=content', async () => {
    const before = await auditService.verifyAuditChain();
    expect(before.ok).toBe(true);

    const { rows } = await pool.query(
      'SELECT id, timestamp FROM audit_log ORDER BY timestamp ASC, id ASC LIMIT 1'
    );
    const targetId = rows[0].id;

    await pool.query('UPDATE audit_log SET action = $1 WHERE id = $2', ['DELETE', targetId]);

    const after = await auditService.verifyAuditChain();
    expect(after.ok).toBe(false);
    expect(after.reason).toBe('content');
  });
});
