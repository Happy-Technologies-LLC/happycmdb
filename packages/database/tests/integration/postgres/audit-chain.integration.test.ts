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
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
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
        organization_id UUID,
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
    }, ORG_A);
    await auditService.logAudit({
      entity_type: 'CI',
      entity_id: 'ci-1',
      action: 'UPDATE',
      actor: 'tester',
      actor_type: 'user',
      changes: [{ field: 'name', old_value: 'a', new_value: 'b' }],
      metadata: { note: 'second' },
    }, ORG_A);
    await auditService.logAudit({
      entity_type: 'RELATIONSHIP',
      entity_id: 'rel-1',
      action: 'RELATIONSHIP_ADD',
      actor: 'system',
      actor_type: 'system',
      changes: [],
    }, ORG_A);

    const { rows } = await pool.query('SELECT id, entry_hash, prev_hash FROM audit_log');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => typeof r.entry_hash === 'string' && r.entry_hash.length > 0)).toBe(
      true
    );

    const verification = await auditService.verifyAuditChain();
    expect(verification.ok).toBe(true);
    expect(verification.checked).toBe(3);
    expect(verification.orgBindingViolations).toEqual([]);
    expect(verification).not.toHaveProperty('valid');
  });

  it('hides recycled/legacy audit rows and detects column-only and metadata tampering', async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM audit_log WHERE entity_type = 'CI' ORDER BY timestamp, id LIMIT 1"
    );
    const id = rows[0]!.id;
    expect((await auditService.getCIAuditHistory('ci-1', ORG_A)).length).toBe(2);
    await pool.query('UPDATE audit_log SET organization_id = $1 WHERE id = $2', [ORG_B, id]);
    expect((await auditService.getCIAuditHistory('ci-1', ORG_A)).length).toBe(1);
    expect(await auditService.getCIAuditHistory('ci-1', ORG_B)).toEqual([]);
    const changed = await auditService.verifyAuditChain();
    expect(changed.ok).toBe(false);
    expect(changed.orgBindingViolations).toContain(id);
    expect(changed.reason).toBe('content'); // HAP-1001 v2 hashes the organization_id column
    await pool.query('UPDATE audit_log SET organization_id = $1 WHERE id = $2', [ORG_A, id]);
    expect((await auditService.verifyAuditChain()).ok).toBe(true);

    await pool.query(
      `INSERT INTO audit_log (entity_type,entity_id,action,actor,changes,timestamp)
       VALUES ('CI','ci-1','CREATE','legacy','[]','2000-01-01')`
    );
    expect((await auditService.getCIAuditHistory('ci-1', ORG_A)).length).toBe(2);
    expect((await auditService.verifyAuditChain()).orgBindingViolations).toEqual([]);
    const legacy = await pool.query<{ id: string }>(
      "SELECT id FROM audit_log WHERE actor = 'legacy'"
    );
    await pool.query('UPDATE audit_log SET organization_id = $1 WHERE id = $2', [ORG_B, legacy.rows[0]!.id]);
    expect((await auditService.verifyAuditChain()).orgBindingViolations).toContain(legacy.rows[0]!.id);
    await pool.query('UPDATE audit_log SET organization_id = NULL WHERE id = $1', [legacy.rows[0]!.id]);
    await pool.query("UPDATE audit_log SET metadata = jsonb_set(metadata, '{organization_id}', to_jsonb($1::text)) WHERE id = $2", [ORG_B, id]);
    const metadataChanged = await auditService.verifyAuditChain();
    expect(metadataChanged.ok).toBe(false);
    expect(metadataChanged.reason).toBe('content');
    expect(metadataChanged.brokenAt).toBe(id);
    expect(metadataChanged.orgBindingViolations).toContain(id);
    await pool.query("UPDATE audit_log SET metadata = jsonb_set(metadata, '{organization_id}', to_jsonb($1::text)) WHERE id = $2", [ORG_A, id]);
    expect((await auditService.verifyAuditChain()).ok).toBe(true);
    await expect(auditService.logAudit({
      entity_type: 'CI', entity_id: 'ci-1', action: 'UPDATE',
      actor: 'tester', actor_type: 'user', changes: [],
    }, '')).rejects.toThrow('Verified actor and organization required');
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
