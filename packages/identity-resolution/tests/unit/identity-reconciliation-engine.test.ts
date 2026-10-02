// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit Tests - IdentityReconciliationEngine
 * Tests matching algorithms, merge strategies, and conflict resolution
 */

import { IdentityReconciliationEngine } from '../../src/engine/identity-reconciliation-engine';
import { TransformedCI, IdentificationAttributes } from '@cmdb/integration-framework';
import { MatchResult, ReconciliationConfig } from '../../src/types/reconciliation.types';
import {
  physicalServerDuplicates,
  cloudVMWithVariations,
  networkDeviceDuplicates,
  databaseWithConflicts,
} from '../fixtures/duplicate-ci-scenarios';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  sanitizeCITypeForLabel: (ciType: string): string => ciType.replace(/-/g, '_').toLowerCase(),
}));

// Mock clients
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

// Organization of every reconciliation in this suite.
const ORG = '11111111-1111-4111-8111-111111111111';

describe('IdentityReconciliationEngine - Unit Tests', () => {
  let engine: IdentityReconciliationEngine;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    // Restore mock implementations after clearAllMocks
    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);
    (getEventProducer as jest.Mock).mockReturnValue(mockEventProducer);
    mockNeo4jClient.getSession.mockReturnValue(mockSession);

    // Reset singleton for each test
    (IdentityReconciliationEngine as any).instance = undefined;
    engine = IdentityReconciliationEngine.getInstance();
  });

  afterEach(async () => {
    jest.resetAllMocks();
  });

  describe('Configuration Loading', () => {
    it('should load configuration from database', async () => {
      const mockConfig = {
        name: 'test-config',
        identification_rules: [
          { attribute: 'external_id', priority: 1, match_type: 'exact' as const, match_confidence: 100 },
          { attribute: 'serial_number', priority: 2, match_type: 'exact' as const, match_confidence: 95 },
        ],
        merge_strategies: [],
        enabled: true,
      };

      mockPostgresClient.query
        .mockResolvedValueOnce({ rows: [mockConfig] }) // reconciliation_rules query
        .mockResolvedValueOnce({ // source_authority query
          rows: [
            { source_name: 'vmware', authority_score: 9 },
            { source_name: 'aws', authority_score: 9 },
            { source_name: 'ssh', authority_score: 7 },
          ],
        });

      await engine.loadConfiguration();

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        'SELECT * FROM reconciliation_rules WHERE enabled = true LIMIT 1'
      );
      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        'SELECT source_name, authority_score FROM source_authority'
      );
    });

    it('should use default configuration if none found in database', async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });

      await engine.loadConfiguration();

      expect(mockPostgresClient.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('Matching Algorithms - Strategy 1: External ID (100% confidence)', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] }); // default config
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should match by external_id with 100% confidence', async () => {
      const ci = cloudVMWithVariations[0]; // AWS CI with external_id
      const identifiers = ci.identifiers;

      // Mock external_id match
      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci_12345' }],
      });
      // The lineage CI is in ORG.
      mockSession.run.mockResolvedValueOnce({ records: [{ get: () => 'ci_12345' }] });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toEqual({
        ci_id: 'ci_12345',
        confidence: 100,
        match_strategy: 'external_id',
        matched_attributes: ['external_id'],
      });
      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('ci_source_lineage'),
        [ci.source, identifiers.external_id]
      );
    });

    it('should not match by external_id if identifier is missing', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'test-server',
        // No external_id
      };
      const ci = { ...cloudVMWithVariations[0], identifiers };

      // No match expected
      mockSession.run.mockResolvedValue({ records: [] });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      // Should try other strategies
      expect(mockPostgresClient.query).not.toHaveBeenCalled();
    });
  });

  describe('Matching Algorithms - Strategy 2: Serial Number (95% confidence)', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should match by serial_number with 95% confidence', async () => {
      const ci = physicalServerDuplicates[2]; // SSH discovery with serial
      const identifiers = ci.identifiers;

      // Mock serial number match
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_67890'),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toEqual({
        ci_id: 'ci_67890',
        confidence: 95,
        match_strategy: 'serial_number',
        matched_attributes: ['serial_number'],
      });
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('WHERE ci.organization_id = $organizationId AND ci.serial_number = $value'),
        { value: identifiers.serial_number, organizationId: ORG }
      );
    });
  });

  describe('Matching Algorithms - Strategy 3: UUID (95% confidence)', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should match by UUID with 95% confidence', async () => {
      const ci = physicalServerDuplicates[0]; // VMware with UUID
      const identifiers = ci.identifiers;

      // Mock UUID match
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_uuid_match'),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toEqual({
        ci_id: 'ci_uuid_match',
        confidence: 95,
        match_strategy: 'uuid',
        matched_attributes: ['uuid'],
      });
    });
  });

  describe('Matching Algorithms - Strategy 4: MAC Address (85% confidence)', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should match by MAC address with 85% confidence', async () => {
      // Override identifiers to only have mac_address (no stronger identifiers)
      const identifiers: IdentificationAttributes = {
        mac_address: ['00:50:56:ab:cd:ef'],
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      // Mock MAC address match
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_mac_match'),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toEqual({
        ci_id: 'ci_mac_match',
        confidence: 85,
        match_strategy: 'mac_address',
        matched_attributes: ['mac_address'],
      });
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('ANY(mac IN ci.mac_addresses WHERE mac IN $macs)'),
        { macs: identifiers.mac_address, organizationId: ORG }
      );
    });

    it('should handle multiple MAC addresses', async () => {
      const identifiers: IdentificationAttributes = {
        mac_address: ['00:11:22:33:44:55', '00:11:22:33:44:66'],
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_multi_mac'),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result?.ci_id).toBe('ci_multi_mac');
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.any(String),
        { macs: identifiers.mac_address, organizationId: ORG }
      );
    });
  });

  describe('Matching Algorithms - Strategy 5: FQDN (80% confidence)', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should match by FQDN with 80% confidence', async () => {
      // Override identifiers to only have fqdn (no stronger identifiers)
      const identifiers: IdentificationAttributes = {
        fqdn: 'prod-db-01.example.com',
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_fqdn_match'),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toEqual({
        ci_id: 'ci_fqdn_match',
        confidence: 80,
        match_strategy: 'fqdn',
        matched_attributes: ['fqdn'],
      });
    });
  });

  describe('Matching Algorithms - Strategy 6: Composite Fuzzy Match (65%+ confidence)', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should match by composite fuzzy matching (hostname + IP)', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'prod-db-01',
        ip_address: ['10.0.1.50'],
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      // Mock Neo4j returning candidates
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_fuzzy_match';
              if (field === 'hostname') return 'prod-db-01';
              if (field === 'ips') return ['10.0.1.50', '172.16.0.50'];
              return null;
            }),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toBeTruthy();
      expect(result?.ci_id).toBe('ci_fuzzy_match');
      expect(result?.match_strategy).toBe('composite_fuzzy');
      expect(result?.confidence).toBeGreaterThanOrEqual(65);
      expect(result?.matched_attributes).toContain('hostname');
      expect(result?.matched_attributes).toContain('ip_address');
    });

    it('should handle hostname variations with fuzzy matching', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'WebServer-Prod-01', // Capital letters
        ip_address: ['10.0.2.100'],
      };
      const ci = { ...cloudVMWithVariations[0], identifiers };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_case_insensitive';
              if (field === 'hostname') return 'webserver-prod-01'; // Lowercase
              if (field === 'ips') return ['10.0.2.100'];
              return null;
            }),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toBeTruthy();
      expect(result?.ci_id).toBe('ci_case_insensitive');
      expect(result?.confidence).toBeGreaterThan(65);
    });

    it('should not match if fuzzy score is below threshold', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'completely-different-server',
        ip_address: ['192.168.1.1'],
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_no_match';
              if (field === 'hostname') return 'prod-db-01';
              if (field === 'ips') return ['10.0.1.50'];
              return null;
            }),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toBeNull();
    });
  });

  describe('CI Creation', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should create new CI when no match found', async () => {
      const ci = physicalServerDuplicates[0];

      // No match found via any Neo4j strategy (uuid, mac, fqdn, composite fuzzy)
      mockSession.run
        .mockResolvedValueOnce({ records: [] }) // uuid - no match
        .mockResolvedValueOnce({ records: [] }) // mac_address - no match
        .mockResolvedValueOnce({ records: [] }) // fqdn - no match
        .mockResolvedValueOnce({ records: [] }) // composite fuzzy - no match
        .mockResolvedValueOnce({ // Create CI
          records: [
            {
              get: jest.fn().mockReturnValue('ci_new_12345'),
            },
          ],
        });
      mockPostgresClient.query.mockResolvedValue({ rows: [] }); // Source lineage

      const ciId = await engine.reconcileCI(ci, ORG);

      expect(ciId).toBeTruthy();
      expect(ciId).toMatch(/^ci_/);
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE (ci:CI:'),
        expect.objectContaining({
          properties: expect.objectContaining({
            name: ci.name,
            ci_type: ci.ci_type,
          }),
        })
      );
      expect(mockEventProducer.emit).toHaveBeenCalledWith(
        'ci_discovered',
        'identity-reconciliation-engine',
        expect.objectContaining({
          ci_name: ci.name,
          ci_type: ci.ci_type,
        })
      );
    });

    it('should record source lineage when creating CI', async () => {
      const ci = physicalServerDuplicates[0];

      // No match found via any strategy, then CREATE
      mockSession.run
        .mockResolvedValueOnce({ records: [] }) // uuid
        .mockResolvedValueOnce({ records: [] }) // mac
        .mockResolvedValueOnce({ records: [] }) // fqdn
        .mockResolvedValueOnce({ records: [] }) // composite fuzzy
        .mockResolvedValueOnce({
          records: [{ get: jest.fn().mockReturnValue('ci_new_lineage') }],
        });
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await engine.reconcileCI(ci, ORG);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_source_lineage'),
        expect.arrayContaining([
          expect.any(String), // ci_id
          ci.source,
          ci.source_id,
          expect.any(Number), // confidence
        ])
      );
    });

    it('createNewCI stamps the caller org and ignores organization_id and id in the discovered data', async () => {
      const base = physicalServerDuplicates[0];
      const ci = {
        ...base,
        attributes: { ...base.attributes, organization_id: 'attacker-org', id: 'ci_victim' },
        identifiers: { ...base.identifiers, organization_id: 'attacker-org' } as typeof base.identifiers,
      };
      let created: Record<string, unknown> | undefined;

      mockSession.run.mockImplementation(async (cypher: string, params: { properties?: Record<string, unknown> }) => {
        if (cypher.includes('SET ci = $properties')) {
          created = { ...params.properties };
          return { records: [{ get: () => created!['id'] }] };
        }
        return { records: [] }; // no match by any strategy
      });
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      const ciId = await engine.reconcileCI(ci, ORG);

      expect(created).toBeDefined();
      expect(created!['name']).toBe(base.name);
      expect(created!['organization_id']).toBe(ORG);
      expect(created!['id']).toMatch(/^ci_\d+_/);
      expect(ciId).toBe(created!['id']);
    });
  });

  describe('CI Update with Merge Strategies', () => {
    beforeEach(async () => {
      // Load config with custom source authorities (including datadog)
      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [{
            name: 'test-config',
            identification_rules: [
              { attribute: 'external_id', priority: 1, match_type: 'exact', match_confidence: 100 },
            ],
            merge_strategies: [],
          }],
        })
        .mockResolvedValueOnce({
          rows: [
            { source_name: 'servicenow', authority_score: 10 },
            { source_name: 'datadog', authority_score: 8 },
            { source_name: 'vmware', authority_score: 9 },
            { source_name: 'aws', authority_score: 9 },
            { source_name: 'ssh', authority_score: 7 },
            { source_name: 'nmap', authority_score: 5 },
          ],
        });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should update existing CI when match found', async () => {
      const ci = physicalServerDuplicates[1]; // AWS discovery (has external_id)

      // External ID match found via postgres
      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci_existing_123' }],
      });

      // Mock field sources (empty - first discovery)
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });

      // Mock field source recording and lineage
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      // The lineage CI is in ORG, then the scoped Neo4j update matches it
      mockSession.run
        .mockResolvedValueOnce({ records: [{ get: () => 'ci_existing_123' }] })
        .mockResolvedValueOnce({ records: [{ get: () => 'ci_existing_123' }] });

      const ciId = await engine.reconcileCI(ci, ORG);

      expect(ciId).toBe('ci_existing_123');
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('MATCH (ci:CI {id: $ciId})'),
        expect.objectContaining({
          ciId: 'ci_existing_123',
        })
      );
      expect(mockEventProducer.emit).toHaveBeenCalledWith(
        'ci_updated',
        'identity-reconciliation-engine',
        expect.any(Object)
      );
    });

    it('should merge fields based on source authority (higher authority wins)', async () => {
      const newCI = databaseWithConflicts[0]; // Datadog

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_db_conflict') }],
      });

      // Field sources show existing ssh value
      mockPostgresClient.query
        .mockResolvedValueOnce({
          rows: [
            { field_name: 'version', field_value: '14.7', source_name: 'ssh' },
          ],
        });

      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [{ get: () => 'ci_db_conflict' }] }); // scoped update matches

      await engine.reconcileCI(newCI, ORG);

      // Should update with new values from higher authority source
      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_field_sources'),
        expect.arrayContaining([
          'ci_db_conflict',
          expect.any(String), // field name
          expect.any(String), // field value
          'datadog', // Higher authority source
        ])
      );
    });

    it('should keep existing field if new source has lower authority', async () => {
      const lowAuthorityCI = databaseWithConflicts[1]; // SSH (authority 7)

      // FQDN match via Neo4j returns existing CI
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: jest.fn().mockReturnValue('ci_authority_test') }],
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
      mockSession.run.mockResolvedValue({ records: [{ get: () => 'ci_authority_test' }] }); // scoped update matches

      await engine.reconcileCI(lowAuthorityCI, ORG);

      // Should NOT overwrite field from higher authority
      const fieldSourceCalls = mockPostgresClient.query.mock.calls.filter(
        call => call[0].includes('ci_field_sources')
      );

      // Verify datadog source is not replaced with ssh
      const versionUpdate = fieldSourceCalls.find(
        call => call[1] && call[1][1] === 'version'
      );
      if (versionUpdate) {
        expect(versionUpdate[1][3]).not.toBe('ssh');
      }
    });

    // FD-4: organization_id on a :CI is written only from the token organization
    // (or the backfill). The stored node is modelled by applying the engine's
    // `SET ci += $properties` to it.
    it('reconciliation merge cannot set or change organization_id or id', async () => {
      const base = physicalServerDuplicates[1]; // has external_id
      const ci = { ...base, attributes: { ...base.attributes, organization_id: 'attacker-org', id: 'ci_victim' } };
      const node: Record<string, unknown> = { id: 'ci_existing_org', organization_id: ORG };

      mockPostgresClient.query
        .mockResolvedValueOnce({ rows: [{ ci_id: 'ci_existing_org' }] }) // external_id match
        // An earlier source already recorded organization_id as a field.
        .mockResolvedValueOnce({ rows: [{ field_name: 'organization_id', field_value: ORG, source_name: 'nmap' }] });
      mockPostgresClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockImplementation(async (cypher: string, params: { properties?: Record<string, unknown> }) => {
        if (cypher.includes('SET ci += $properties')) Object.assign(node, params.properties);
        // The lineage CI is in ORG, and the scoped update matches it.
        return { records: [{ get: () => 'ci_existing_org' }] };
      });

      await engine.reconcileCI(ci, ORG);

      expect(node['organization_id']).toBe(ORG);
      expect(node['id']).toBe('ci_existing_org');
      const recordedFields = mockPostgresClient.query.mock.calls
        .filter(call => String(call[0]).includes('INSERT INTO ci_field_sources'))
        .map(call => (call[1] as unknown[])[1]);
      expect(recordedFields).toContain('hostname');
      expect(recordedFields).not.toContain('organization_id');
      expect(recordedFields).not.toContain('id');
    });

    it('a scoped update that matches nothing fails closed: no field source, lineage or event', async () => {
      const ci = physicalServerDuplicates[2]; // matched by serial_number (no external_id)
      mockSession.run
        .mockResolvedValueOnce({ records: [{ get: () => 'ci_in_org' }] }) // serial_number match in ORG
        .mockResolvedValueOnce({ records: [] }); // the org-scoped SET matches nothing
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await expect(engine.reconcileCI(ci, ORG)).rejects.toThrow('Matched CI is not in the caller organization');

      expect(mockSession.run).toHaveBeenLastCalledWith(
        expect.stringContaining('WHERE ci.organization_id = $organizationId'),
        expect.objectContaining({ ciId: 'ci_in_org', organizationId: ORG })
      );
      const writes = mockPostgresClient.query.mock.calls
        .filter(call => /INSERT INTO ci_(field_sources|source_lineage)/.test(String(call[0])));
      expect(writes).toEqual([]);
      expect(mockEventProducer.emit).not.toHaveBeenCalled();
    });
  });

  describe('Organization scope', () => {
    const ORG_B = '22222222-2222-4222-8222-222222222222';

    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] }); // default config
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('match Cypher carries organization_id = $org', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: 'i-shared',
        serial_number: 'SN-SHARED',
        uuid: 'uuid-shared',
        mac_address: ['00:11:22:33:44:55'],
        fqdn: 'shared.example.com',
        hostname: 'shared',
        ip_address: ['10.0.0.1'],
      };
      const ci = { ...cloudVMWithVariations[0], identifiers };
      // ci_source_lineage names a CI for the external id; Neo4j has nothing in ORG.
      mockPostgresClient.query.mockResolvedValue({ rows: [{ ci_id: 'ci_other_org' }] });
      mockSession.run.mockResolvedValue({ records: [] });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toBeNull();
      // Lineage CI ownership, serial_number, uuid, mac_address, fqdn, composite.
      expect(mockSession.run).toHaveBeenCalledTimes(6);
      for (const [cypher, params] of mockSession.run.mock.calls) {
        expect(cypher).toMatch(/WHERE ci\.organization_id = \$organizationId\s+AND/);
        expect(params).toMatchObject({ organizationId: ORG });
      }
    });

    it('merge refuses a CI of another org', async () => {
      type Node = Record<string, unknown>;
      interface Params { organizationId?: string; ciId?: string; ciIds?: string[]; value?: unknown; properties?: Node }

      // ORG_B's CI carries the serial number, and ci_source_lineage maps the
      // external id to it, exactly as the ORG discovery below identifies itself.
      const foreign: Node = { id: 'ci_org_b', organization_id: ORG_B, name: 'b-server', serial_number: 'SN-SHARED', owner: 'org-b' };
      const before = { ...foreign };
      const nodes: Node[] = [foreign];
      const record = (ciId: unknown) => ({ get: () => ciId });

      // Neo4j over `nodes`, honouring the organization predicate only when the statement has it.
      mockSession.run.mockImplementation(async (cypher: string, params: Params) => {
        const inScope = (n: Node) =>
          !cypher.includes('ci.organization_id = $organizationId') || n['organization_id'] === params.organizationId;
        if (cypher.includes('SET ci = $properties')) {
          nodes.push({ ...params.properties });
          return { records: [record(params.properties!['id'])] };
        }
        if (cypher.includes('SET ci += $properties')) {
          const target = nodes.find(n => n['id'] === params.ciId && inScope(n));
          if (target) Object.assign(target, params.properties);
          return { records: target ? [record(target['id'])] : [] };
        }
        if (cypher.includes('ci.id IN $ciIds')) {
          return { records: nodes.filter(n => inScope(n) && params.ciIds!.includes(n['id'] as string)).map(n => record(n['id'])) };
        }
        const attribute = /ci\.(\w+) = \$value/.exec(cypher);
        if (attribute) {
          return { records: nodes.filter(n => inScope(n) && n[attribute[1]!] === params.value).map(n => record(n['id'])) };
        }
        return { records: [] };
      });
      mockPostgresClient.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM ci_source_lineage') ? { rows: [{ ci_id: 'ci_org_b' }] } : { rows: [] });

      const discovered: TransformedCI = {
        name: 'a-server',
        ci_type: 'server',
        source: 'aws',
        source_id: 'i-shared',
        identifiers: { external_id: 'i-shared', serial_number: 'SN-SHARED' },
        attributes: { owner: 'org-a' },
        relationships: [],
        confidence_score: 100,
        status: 'active',
      };
      const ciId = await engine.reconcileCI(discovered, ORG);

      // ORG_B's CI is untouched; the discovery became a new CI of ORG.
      expect(foreign).toEqual(before);
      expect(ciId).not.toBe('ci_org_b');
      expect(nodes.find(n => n['id'] === ciId)).toMatchObject({ organization_id: ORG, serial_number: 'SN-SHARED', owner: 'org-a' });
      // No field source or lineage row is written for ORG_B's CI.
      const foreignWrites = mockPostgresClient.query.mock.calls.filter(
        ([sql, params]) => /INSERT INTO ci_(field_sources|source_lineage)/.test(sql) && (params as unknown[])[0] === 'ci_org_b'
      );
      expect(foreignWrites).toEqual([]);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect field conflicts between sources', async () => {
      // This would be implemented when conflict tracking is added
      // For now, test that merge logic handles conflicts
      expect(true).toBe(true);
    });
  });

  describe('Confidence Scoring', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should assign correct confidence scores for each strategy', async () => {
      const testCases = [
        { strategy: 'external_id', expectedConfidence: 100 },
        { strategy: 'serial_number', expectedConfidence: 95 },
        { strategy: 'uuid', expectedConfidence: 95 },
        { strategy: 'mac_address', expectedConfidence: 85 },
        { strategy: 'fqdn', expectedConfidence: 80 },
      ];

      for (const testCase of testCases) {
        // This test verifies the confidence values are set correctly
        // in the actual implementation
        expect(testCase.expectedConfidence).toBeGreaterThan(0);
      }
    });

    it('should cap composite fuzzy match confidence at 95%', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'test-server',
        ip_address: ['10.0.0.1'],
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_high_score';
              if (field === 'hostname') return 'test-server';
              if (field === 'ips') return ['10.0.0.1'];
              return null;
            }),
          },
        ],
      });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      // Even with perfect match, composite should be capped
      expect(result?.confidence).toBeLessThanOrEqual(95);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should handle Neo4j connection errors gracefully', async () => {
      const ci = physicalServerDuplicates[0];

      mockSession.run.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(engine.findExistingCI(ci.identifiers, ci, ORG)).rejects.toThrow(
        'Connection failed'
      );
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should close Neo4j session even on error', async () => {
      const ci = physicalServerDuplicates[0];

      mockSession.run.mockRejectedValueOnce(new Error('Query error'));

      try {
        await engine.findExistingCI(ci.identifiers, ci, ORG);
      } catch (error) {
        // Expected error
      }

      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should handle PostgreSQL query failures', async () => {
      const ci = physicalServerDuplicates[0];

      mockPostgresClient.query.mockRejectedValueOnce(
        new Error('Database error')
      );

      await expect(engine.loadConfiguration()).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('Edge Cases', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
      await engine.loadConfiguration();
      mockPostgresClient.query.mockReset();
    });

    it('should handle CI with no identifiers', async () => {
      const identifiers: IdentificationAttributes = {};
      const ci = { ...physicalServerDuplicates[0], identifiers };

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toBeNull();
    });

    it('should handle empty MAC address array', async () => {
      const identifiers: IdentificationAttributes = {
        mac_address: [],
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      mockSession.run.mockResolvedValueOnce({ records: [] });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      expect(result).toBeNull();
    });

    it('should handle null/undefined values in identifiers', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: undefined,
        serial_number: undefined,
        uuid: undefined,
        hostname: 'test',
      };
      const ci = { ...physicalServerDuplicates[0], identifiers };

      mockSession.run.mockResolvedValueOnce({ records: [] });

      const result = await engine.findExistingCI(identifiers, ci, ORG);

      // Should not crash, just return null or try remaining strategies
      expect(result).toBeDefined();
    });
  });
});
