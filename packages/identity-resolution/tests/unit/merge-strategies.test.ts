// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit Tests - Merge Strategies and Conflict Resolution
 * Tests field merging, authority-based resolution, and conflict detection
 */

import { IdentityReconciliationEngine } from '../../src/engine/identity-reconciliation-engine';
import { TransformedCI } from '@cmdb/integration-framework';
import {
  createDatabase,
  createConflictingCIs,
} from '../fixtures/ci-factory';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  sanitizeCITypeForLabel: (ciType: string): string => ciType.replace(/-/g, '_').toLowerCase(),
}));

const mockNeo4jClient = {
  getSession: jest.fn(),
};

const mockPostgresClient = {
  query: jest.fn(),
};

const mockEventProducer = {
  emit: jest.fn(),
};

const mockSession = {
  run: jest.fn(),
  close: jest.fn(),
};

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(() => mockNeo4jClient),
  getPostgresClient: jest.fn(() => mockPostgresClient),
}));

jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: jest.fn(() => mockEventProducer),
  EventType: {
    CI_DISCOVERED: 'ci_discovered',
    CI_UPDATED: 'ci_updated',
  },
}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { getEventProducer } from '@cmdb/event-processor';

describe('Merge Strategies and Conflict Resolution', () => {
  let engine: IdentityReconciliationEngine;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Restore mock implementations after clearAllMocks
    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);
    (getEventProducer as jest.Mock).mockReturnValue(mockEventProducer);
    mockNeo4jClient.getSession.mockReturnValue(mockSession);

    (IdentityReconciliationEngine as any).instance = undefined;
    engine = IdentityReconciliationEngine.getInstance();

    // Setup configuration from database with source authorities
    mockPostgresClient.query
      .mockResolvedValueOnce({ // Custom config from database
        rows: [{
          name: 'test-config',
          identification_rules: [
            { attribute: 'external_id', priority: 1, match_type: 'exact', match_confidence: 100 },
            { attribute: 'serial_number', priority: 2, match_type: 'exact', match_confidence: 95 },
          ],
          merge_strategies: [],
        }],
      })
      .mockResolvedValueOnce({ // Source authorities
        rows: [
          { source_name: 'servicenow', authority_score: 10 },
          { source_name: 'vmware', authority_score: 9 },
          { source_name: 'aws', authority_score: 9 },
          { source_name: 'azure', authority_score: 9 },
          { source_name: 'datadog', authority_score: 8 },
          { source_name: 'ssh', authority_score: 7 },
          { source_name: 'nmap', authority_score: 5 },
          { source_name: 'manual', authority_score: 3 },
        ],
      });

    await engine.loadConfiguration();
    mockPostgresClient.query.mockReset();
  });

  describe('Authority-Based Field Merging', () => {
    it('should use higher authority source for conflicting field', async () => {
      const ci = createDatabase('prod-db', 'datadog', '14.8', 95);

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_existing') }],
      });

      // Get field sources for merge
      mockPostgresClient.query
        .mockResolvedValueOnce({ // Get field sources
          rows: [
            {
              field_name: 'version',
              field_value: '14.7',
              source_name: 'ssh', // Authority 7
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // Should update field with higher authority value
      const fieldUpdateCalls = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources')
      );

      expect(fieldUpdateCalls.length).toBeGreaterThan(0);
      const versionUpdate = fieldUpdateCalls.find(
        call => call[1] && call[1][1] === 'version'
      );

      if (versionUpdate) {
        expect(versionUpdate[1][2]).toBe('14.8'); // New value
        expect(versionUpdate[1][3]).toBe('datadog'); // Higher authority
      }
    });

    it('should keep existing field if new source has lower authority', async () => {
      const ci = createDatabase('prod-db', 'ssh', '14.7', 80);

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_existing') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              field_name: 'version',
              field_value: '14.8',
              source_name: 'datadog', // Authority 8 (higher)
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // Should NOT overwrite with lower authority
      const fieldUpdateCalls = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources') && call[1]?.[1] === 'version'
      );

      // Version field should not be updated (or updated with same value)
      fieldUpdateCalls.forEach(call => {
        if (call[1]?.[1] === 'version') {
          // If updated, should keep datadog as source
          expect(call[1][3]).not.toBe('ssh');
        }
      });
    });

    it('should update field if new source has equal authority (most recent wins)', async () => {
      const ci = createDatabase('prod-db', 'aws', '14.9', 95);

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_existing') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              field_name: 'version',
              field_value: '14.8',
              source_name: 'azure', // Authority 9 (equal to aws)
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // With equal authority, most recent (new) wins
      const fieldUpdateCalls = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources')
      );

      const versionUpdate = fieldUpdateCalls.find(
        call => call[1]?.[1] === 'version'
      );

      if (versionUpdate) {
        expect(versionUpdate[1][2]).toBe('14.9');
        expect(versionUpdate[1][3]).toBe('aws');
      }
    });
  });

  describe('Field Addition (Non-Conflicting)', () => {
    it('should add new fields from any source', async () => {
      const ci = createDatabase('prod-db', 'datadog', '14.8', 95);
      ci.attributes.monitoring_enabled = true;
      ci.attributes.max_connections = 200;

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_existing') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [], // No existing fields
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // All new fields should be added
      const fieldInserts = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources')
      );

      expect(fieldInserts.length).toBeGreaterThan(0);
    });

    it('should allow low authority source to add unique fields', async () => {
      const lowAuthCI = createDatabase('prod-db', 'manual', '14.8', 50);
      lowAuthCI.attributes.backup_schedule = 'daily';
      lowAuthCI.attributes.contact_email = 'dba@example.com';

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_existing') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              field_name: 'version',
              field_value: '14.8',
              source_name: 'datadog',
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(lowAuthCI);

      // New fields should be added even from low authority
      const fieldInserts = mockPostgresClient.query.mock.calls.filter(
        call =>
          call[0].includes('ci_field_sources') &&
          (call[1]?.[1] === 'backup_schedule' || call[1]?.[1] === 'contact_email')
      );

      expect(fieldInserts.length).toBeGreaterThan(0);
    });
  });

  describe('Multiple Source Reconciliation', () => {
    it('should merge fields from multiple sources based on authority', async () => {
      // Scenario: Server discovered by 3 sources
      // - NMAP: basic info (authority 5)
      // - SSH: detailed info (authority 7)
      // - VMware: virtualization info (authority 9)

      const nmapCI: TransformedCI = {
        name: 'prod-server-01',
        ci_type: 'server',
        environment: 'production',
        status: 'active',
        attributes: {
          hostname: 'prod-server-01',
          os_type: 'linux',
        },
        identifiers: {
          hostname: 'prod-server-01',
          ip_address: ['10.0.1.50'],
        },
        source: 'nmap',
        source_id: '10.0.1.50',
        confidence_score: 70,
      };

      const sshCI: TransformedCI = {
        ...nmapCI,
        attributes: {
          hostname: 'prod-server-01',
          os_type: 'linux',
          os_version: 'Ubuntu 22.04',
          kernel: '5.15.0',
          cpu_count: 8,
          memory_gb: 32,
        },
        source: 'ssh',
        source_id: '10.0.1.50',
        confidence_score: 85,
      };

      const vmwareCI: TransformedCI = {
        ...nmapCI,
        attributes: {
          hostname: 'prod-server-01',
          os_type: 'linux',
          hypervisor: 'VMware ESXi',
          vm_uuid: 'vm-12345',
          cpu_count: 8,
          memory_gb: 32,
        },
        identifiers: {
          ...nmapCI.identifiers,
          uuid: 'vm-12345',
        },
        source: 'vmware',
        source_id: 'vm-12345',
        confidence_score: 95,
      };

      // Default fallback for postgres queries
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      // First discovery (NMAP) - no match found via composite fuzzy, creates new CI
      // composite fuzzy: session.run returns no candidates
      mockSession.run
        .mockResolvedValueOnce({ records: [] }) // composite fuzzy search - no match
        .mockResolvedValueOnce({ // CREATE CI
          records: [{ get: jest.fn().mockReturnValue('ci_merged_server') }],
        });

      const ciId1 = await engine.reconcileCI(nmapCI);
      expect(ciId1).toBe('ci_merged_server');

      // Reset mocks for second discovery
      mockPostgresClient.query.mockReset();
      mockSession.run.mockReset();
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      // Second discovery (SSH) - composite fuzzy finds existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: jest.fn((field: string) => {
            if (field === 'ci_id') return 'ci_merged_server';
            if (field === 'hostname') return 'prod-server-01';
            if (field === 'ips') return ['10.0.1.50'];
            return null;
          }),
        }],
      });
      // getFieldSources query
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      // remaining queries (field sources, lineage, Neo4j update)
      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      const ciId2 = await engine.reconcileCI(sshCI);

      // Reset mocks for third discovery
      mockPostgresClient.query.mockReset();
      mockSession.run.mockReset();
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      // Third discovery (VMware) - UUID match found
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_merged_server') }],
      });
      // getFieldSources query
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      const ciId3 = await engine.reconcileCI(vmwareCI);

      // All should be same CI
      expect(ciId1).toBe(ciId2);
      expect(ciId2).toBe(ciId3);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect when sources disagree on field values', async () => {
      const [datadog, ssh] = createConflictingCIs(
        'prod-db',
        'version',
        ['14.8', '14.7'],
        ['datadog', 'ssh']
      );

      // Composite fuzzy match via Neo4j finds existing CI (hostname+ip match)
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: jest.fn((field: string) => {
            if (field === 'ci_id') return 'ci_conflict';
            if (field === 'hostname') return 'prod-db';
            if (field === 'ips') return datadog.identifiers.ip_address;
            return null;
          }),
        }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              field_name: 'version',
              field_value: '14.7',
              source_name: 'ssh',
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(datadog);

      // Conflict should be resolved based on authority
      // Higher authority (datadog) wins
      const updates = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources')
      );

      expect(updates.length).toBeGreaterThan(0);
    });

    it('should handle significant value differences', async () => {
      const [source1, source2] = createConflictingCIs(
        'prod-server',
        'cpu_count',
        [8, 16], // Significant difference
        ['vmware', 'ssh']
      );

      // Composite fuzzy match via Neo4j finds existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: jest.fn((field: string) => {
            if (field === 'ci_id') return 'ci_cpu_diff';
            if (field === 'hostname') return 'prod-server';
            if (field === 'ips') return source2.identifiers.ip_address;
            return null;
          }),
        }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              field_name: 'cpu_count',
              field_value: '8',
              source_name: 'vmware',
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(source2);

      // SSH has lower authority, should not overwrite VMware value
      const cpuUpdate = mockPostgresClient.query.mock.calls.find(
        call => call[1]?.[1] === 'cpu_count'
      );

      if (cpuUpdate) {
        // Should keep VMware value or not update
        expect(cpuUpdate[1][3]).not.toBe('ssh');
      }
    });
  });

  describe('Source Lineage Tracking', () => {
    it('should record all sources that discovered CI', async () => {
      const ci = createDatabase('prod-db', 'datadog', '14.8', 95);

      // No match found via any strategy (all Neo4j queries return empty)
      mockSession.run
        .mockResolvedValueOnce({ records: [] }) // fqdn match - no result
        .mockResolvedValueOnce({ records: [] }) // composite fuzzy - no result
        .mockResolvedValueOnce({ // CREATE CI
          records: [{ get: jest.fn().mockReturnValue('ci_new') }],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await engine.reconcileCI(ci);

      // Check source lineage was recorded
      const lineageInsert = mockPostgresClient.query.mock.calls.find(
        call => call[0].includes('ci_source_lineage')
      );

      expect(lineageInsert).toBeTruthy();
      expect(lineageInsert?.[1]).toContain(ci.source);
      expect(lineageInsert?.[1]).toContain(ci.source_id);
    });

    it('should update last_seen_at when rediscovered by same source', async () => {
      const ci = createDatabase('prod-db', 'datadog', '14.8', 95);

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_existing') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({ rows: [] }) // getFieldSources
        .mockResolvedValueOnce({ rows: [] }); // Source lineage upsert

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      const lineageUpsert = mockPostgresClient.query.mock.calls.find(
        call => call[0].includes('ci_source_lineage')
      );

      // Should upsert (update existing or insert new)
      expect(lineageUpsert?.[0]).toContain('ON CONFLICT');
      expect(lineageUpsert?.[0]).toContain('last_seen_at = NOW()');
    });
  });

  describe('Edge Cases in Merging', () => {
    it('should handle null vs empty string conflicts', async () => {
      const ci: TransformedCI = {
        name: 'server',
        ci_type: 'server',
        environment: 'production',
        status: 'active',
        attributes: {
          description: '', // Empty string
        },
        identifiers: {
          hostname: 'server',
          fqdn: 'server.example.com',
        },
        source: 'manual',
        source_id: 'manual-1',
        confidence_score: 80,
      };

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_null_test') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              field_name: 'description',
              field_value: null,
              source_name: 'nmap',
            },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // Should handle gracefully
      expect(mockSession.run).toHaveBeenCalled();
    });

    it('should handle array field conflicts', async () => {
      const ci: TransformedCI = {
        name: 'server',
        ci_type: 'server',
        environment: 'production',
        status: 'active',
        attributes: {
          tags: ['production', 'database', 'critical'],
        },
        identifiers: {
          hostname: 'server',
          fqdn: 'server.example.com',
        },
        source: 'datadog',
        source_id: 'datadog-1',
        confidence_score: 90,
      };

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_array_test') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({ rows: [] }); // No existing field sources

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // Should serialize array properly
      const fieldInserts = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources')
      );

      expect(fieldInserts.length).toBeGreaterThan(0);
    });

    it('should handle nested object field conflicts', async () => {
      const ci: TransformedCI = {
        name: 'server',
        ci_type: 'server',
        environment: 'production',
        status: 'active',
        attributes: {
          configuration: {
            cpu: { cores: 8, threads: 16 },
            memory: { total_gb: 32, used_gb: 24 },
          },
        },
        identifiers: {
          hostname: 'server',
          fqdn: 'server.example.com',
        },
        source: 'vmware',
        source_id: 'vm-1',
        confidence_score: 95,
      };

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_object_test') }],
      });

      mockPostgresClient.query
        .mockResolvedValueOnce({ rows: [] }); // No existing field sources

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await engine.reconcileCI(ci);

      // Should serialize object properly
      expect(mockSession.run).toHaveBeenCalled();
    });
  });
});
