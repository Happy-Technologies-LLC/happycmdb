// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Drift Detector Unit Tests
 * Tests for configuration drift detection by comparing baseline snapshots
 */

import { AnomalySeverity } from '../../src/types/anomaly.types';
import {
  mockCIs,
  mockBaselineSnapshots,
  mockDriftedConfig,
  mockTimeSeriesMetrics,
  createMockNeo4jSession,
  createMockPgClient,
  createMockEventProducer,
  createMockNeo4jRecord,
} from '../fixtures/test-data';

// Mock dependencies
jest.mock('@cmdb/database');
jest.mock('@cmdb/event-processor');
jest.mock('uuid', () => ({ v4: () => 'drift-test-uuid' }));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { getEventProducer } from '@cmdb/event-processor';

import { ConfigurationDriftDetector } from '../../src/engines/configuration-drift-detector';

describe('ConfigurationDriftDetector', () => {
  let detector: ConfigurationDriftDetector;
  let mockNeo4jClient: any;
  let mockPgClient: any;
  let mockEventProducer: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset singleton so each test gets a fresh instance
    (ConfigurationDriftDetector as any).instance = undefined;

    mockNeo4jClient = {
      getSession: jest.fn(),
    };
    mockPgClient = createMockPgClient([]);
    mockEventProducer = createMockEventProducer();

    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getPostgresClient as jest.Mock).mockReturnValue(mockPgClient);
    (getEventProducer as jest.Mock).mockReturnValue(mockEventProducer);

    detector = ConfigurationDriftDetector.getInstance();
  });

  describe('createBaseline', () => {
    it('should create configuration baseline snapshot', async () => {
      // createBaseline calls neo4j to get CI, then filters system fields
      // The CI node is accessed via record.get('ci').properties
      const mockSession = createMockNeo4jSession([
        {
          ci: mockCIs.webServer,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);
      mockPgClient.query.mockResolvedValue({ rows: [] });

      const baseline = await detector.createBaseline(
        'ci-web-001',
        'configuration',
        'admin'
      );

      expect(baseline).toBeDefined();
      expect(baseline.ci_id).toBe('ci-web-001');
      expect(baseline.snapshot_type).toBe('configuration');
      expect(baseline.created_by).toBe('admin');
      expect(baseline.is_approved).toBe(false);
      expect(baseline.snapshot_data).toBeDefined();

      // Should store baseline
      expect(mockPgClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO baseline_snapshots'),
        expect.any(Array)
      );
    });

    it('should create performance baseline with metrics', async () => {
      const mockSession = createMockNeo4jSession([
        {
          ci: mockCIs.webServer,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      // For 'performance' snapshot, createBaseline first queries Neo4j for the CI,
      // then calls capturePerformanceSnapshot which queries postgres for metrics.
      // The storeBaseline call also queries postgres.
      mockPgClient.query
        .mockResolvedValueOnce({ rows: mockTimeSeriesMetrics }) // capturePerformanceSnapshot
        .mockResolvedValueOnce({ rows: [] }); // storeBaseline INSERT

      const baseline = await detector.createBaseline(
        'ci-web-001',
        'performance',
        'system'
      );

      expect(baseline.snapshot_type).toBe('performance');
      expect(baseline.snapshot_data).toHaveProperty('cpu_usage');
      expect(baseline.snapshot_data).toHaveProperty('memory_usage');
    });

    it('should create relationships baseline', async () => {
      // createBaseline for 'relationships' calls:
      // 1. neo4j session.run to get CI node (first getSession call)
      // 2. Then captureRelationshipsSnapshot opens a NEW session (second getSession call)

      // First session: get CI node
      const ciSession = createMockNeo4jSession([
        {
          ci: mockCIs.webServer,
        },
      ]);

      // Second session: get relationships
      const relSession = {
        run: jest.fn().mockResolvedValueOnce({
          records: [
            createMockNeo4jRecord({
              rel_type: 'DEPENDS_ON',
              related_id: 'ci-db-001',
              related_name: 'postgres-prod-01',
              is_outgoing: true,
            }),
          ],
        }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      mockNeo4jClient.getSession
        .mockReturnValueOnce(ciSession)
        .mockReturnValueOnce(relSession);

      mockPgClient.query.mockResolvedValue({ rows: [] });

      const baseline = await detector.createBaseline(
        'ci-web-001',
        'relationships',
        'system'
      );

      expect(baseline.snapshot_type).toBe('relationships');
      expect(baseline.snapshot_data).toHaveProperty('outgoing');
      expect(baseline.snapshot_data).toHaveProperty('incoming');
    });

    it('should throw error if CI not found', async () => {
      const mockSession = createMockNeo4jSession([]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      await expect(
        detector.createBaseline('ci-nonexistent', 'configuration', 'admin')
      ).rejects.toThrow('CI not found');
    });
  });

  describe('detectDrift', () => {
    /**
     * Helper: detectDrift flow:
     * 1. getApprovedBaseline -> postgres query (needs is_approved baseline row)
     * 2. neo4j session.run to get current CI
     * 3. captureConfigurationSnapshot (filters system fields)
     * 4. compareConfigurations
     * 5. storeDriftResult -> postgres INSERT
     * 6. optionally emit event
     */

    it('should detect no drift when configuration unchanged', async () => {
      // First postgres query: getApprovedBaseline
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] }); // storeDriftResult

      // Neo4j: get current CI config
      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.noChange,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      expect(result.has_drift).toBe(false);
      expect(result.drift_score).toBe(0);
      expect(result.drifted_fields).toHaveLength(0);
    });

    it('should throw when no approved baseline exists for the CI', async () => {
      mockPgClient.query.mockResolvedValueOnce({ rows: [] }); // getApprovedBaseline: none found

      await expect(detector.detectDrift('ci-no-baseline')).rejects.toThrow(
        'No approved baseline found'
      );
      expect(mockNeo4jClient.getSession).not.toHaveBeenCalled();
    });

    it('should detect minor drift (non-critical fields)', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.minorDrift,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      expect(result.has_drift).toBe(true);
      expect(result.drift_score).toBeGreaterThan(0);
      expect(result.drift_score).toBeLessThan(50);
      expect(result.drifted_fields).toHaveLength(2); // version, max_connections

      const versionDrift = result.drifted_fields.find(f => f.field_name === 'version');
      expect(versionDrift).toBeDefined();
      expect(versionDrift?.baseline_value).toBe('2.0.1');
      expect(versionDrift?.current_value).toBe('2.0.2');
      expect(versionDrift?.change_type).toBe('modified');
    });

    it('should detect critical drift (IP/hostname changes)', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.criticalDrift,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      expect(result.has_drift).toBe(true);
      expect(result.drift_score).toBeGreaterThan(50);

      const ipDrift = result.drifted_fields.find(f => f.field_name === 'ip_address');
      expect(ipDrift?.severity).toBe(AnomalySeverity.HIGH);

      const hostnameDrift = result.drifted_fields.find(f => f.field_name === 'hostname');
      expect(hostnameDrift?.severity).toBe(AnomalySeverity.HIGH);
    });

    it('should detect added fields', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.fieldAdded,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      expect(result.has_drift).toBe(true);

      const addedField = result.drifted_fields.find(f => f.field_name === 'ssl_enabled');
      expect(addedField).toBeDefined();
      expect(addedField?.change_type).toBe('added');
      expect(addedField?.baseline_value).toBeNull();
      expect(addedField?.current_value).toBe(true);
    });

    it('should detect removed fields', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.fieldRemoved,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      expect(result.has_drift).toBe(true);

      const removedHostname = result.drifted_fields.find(f => f.field_name === 'hostname');
      expect(removedHostname).toBeDefined();
      expect(removedHostname?.change_type).toBe('removed');
      expect(removedHostname?.severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('should emit event for significant drift', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.criticalDrift,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      await detector.detectDrift('ci-web-001');

      expect(mockEventProducer.emit).toHaveBeenCalled();
    });

    it('should not emit event for minor drift', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      // Create config with very minor drift (score < 30)
      const minorConfig = {
        ...mockDriftedConfig.noChange,
        max_connections: 105, // Small change
      };

      const mockSession = createMockNeo4jSession([
        {
          ci: minorConfig,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      await detector.detectDrift('ci-web-001');

      expect(mockEventProducer.emit).not.toHaveBeenCalled();
    });

    it('should throw error if no approved baseline exists', async () => {
      mockPgClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(detector.detectDrift('ci-web-001')).rejects.toThrow(
        'No approved baseline found'
      );
    });
  });

  describe('approveBaseline', () => {
    it('should approve a baseline snapshot', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({
          rows: [
            {
              ...mockBaselineSnapshots.configuration,
              is_approved: true,
              approved_by: 'admin',
              approved_at: new Date(),
            },
          ],
        }); // SELECT after update

      const result = await detector.approveBaseline('baseline-001', 'admin');

      expect(result.is_approved).toBe(true);
      expect(result.approved_by).toBe('admin');
      expect(mockPgClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE baseline_snapshots'),
        ['baseline-001', 'admin']
      );
    });
  });

  describe('getBaselineById', () => {
    it('should return the baseline snapshot for a known id', async () => {
      mockPgClient.query.mockResolvedValueOnce({
        rows: [mockBaselineSnapshots.configuration],
      });

      const result = await detector.getBaselineById('baseline-001');

      expect(result).not.toBeNull();
      expect(result?.id).toBe(mockBaselineSnapshots.configuration.id);
      expect(mockPgClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM baseline_snapshots'),
        ['baseline-001']
      );
    });

    it('should return null for an unknown baseline id', async () => {
      mockPgClient.query.mockResolvedValueOnce({ rows: [] });

      const result = await detector.getBaselineById('baseline-nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getDriftHistory', () => {
    it('should retrieve drift history for a CI', async () => {
      const mockHistory = [
        {
          ci_id: 'ci-web-001',
          ci_name: 'web-server-prod-01',
          has_drift: true,
          drift_score: 45,
          drifted_fields: [],
          baseline_snapshot_id: 'baseline-001',
          detected_at: new Date(),
        },
      ];

      mockPgClient.query.mockResolvedValueOnce({ rows: mockHistory });

      const result = await detector.getDriftHistory('ci-web-001', 10);

      expect(result).toHaveLength(1);
      expect(result[0].ci_id).toBe('ci-web-001');
      expect(result[0].has_drift).toBe(true);
    });
  });

  describe('drift severity calculation', () => {
    it('should assign CRITICAL severity to removed critical fields', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const configMissingIP = {
        ...mockDriftedConfig.noChange,
      };
      delete (configMissingIP as any).ip_address;

      const mockSession = createMockNeo4jSession([
        {
          ci: configMissingIP,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      const ipDrift = result.drifted_fields.find(f => f.field_name === 'ip_address');
      expect(ipDrift?.severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('should assign HIGH severity to credential/security field changes', async () => {
      const baselineWithCreds = {
        ...mockBaselineSnapshots.configuration,
        snapshot_data: {
          ...mockBaselineSnapshots.configuration.snapshot_data,
          access_key: 'old-key',
        },
      };

      const currentWithNewCreds = {
        ...mockDriftedConfig.noChange,
        access_key: 'new-key',
      };

      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [baselineWithCreds],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: currentWithNewCreds,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      const credDrift = result.drifted_fields.find(f => f.field_name === 'access_key');
      expect(credDrift?.severity).toBe(AnomalySeverity.HIGH);
    });
  });

  describe('value comparison', () => {
    it('should correctly compare arrays', async () => {
      const baselineWithArray = {
        ...mockBaselineSnapshots.configuration,
        snapshot_data: {
          tags: ['prod', 'web', 'critical'],
        },
      };

      const currentWithChangedArray = {
        tags: ['prod', 'web'], // 'critical' removed
      };

      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [baselineWithArray],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: currentWithChangedArray,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      const tagsDrift = result.drifted_fields.find(f => f.field_name === 'tags');
      expect(tagsDrift).toBeDefined();
      expect(tagsDrift?.change_type).toBe('modified');
    });

    it('should correctly compare nested objects', async () => {
      const baselineWithNested = {
        ...mockBaselineSnapshots.configuration,
        snapshot_data: {
          metadata: { tier: 'premium', region: 'us-east-1' },
        },
      };

      const currentWithChangedNested = {
        metadata: { tier: 'premium', region: 'us-west-2' }, // Region changed
      };

      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [baselineWithNested],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: currentWithChangedNested,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      const metadataDrift = result.drifted_fields.find(f => f.field_name === 'metadata');
      expect(metadataDrift).toBeDefined();
    });
  });

  describe('drift score calculation', () => {
    it('should calculate high drift score for multiple critical changes', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [mockBaselineSnapshots.configuration],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: mockDriftedConfig.criticalDrift,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      // Multiple HIGH/CRITICAL severity changes should result in high score
      expect(result.drift_score).toBeGreaterThan(70);
    });

    it('should cap drift score at 100', async () => {
      const extremelyDriftedConfig = {
        field1: 'changed',
        field2: 'changed',
        field3: 'changed',
        ip_address: 'changed',
        hostname: 'changed',
        status: 'changed',
        environment: 'changed',
      };

      const baselineWithManyFields = {
        ...mockBaselineSnapshots.configuration,
        snapshot_data: {
          field1: 'original',
          field2: 'original',
          field3: 'original',
          ip_address: 'original',
          hostname: 'original',
          status: 'original',
          environment: 'original',
        },
      };

      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [baselineWithManyFields],
        })
        .mockResolvedValue({ rows: [] });

      const mockSession = createMockNeo4jSession([
        {
          ci: extremelyDriftedConfig,
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(mockSession);

      const result = await detector.detectDrift('ci-web-001');

      expect(result.drift_score).toBeLessThanOrEqual(100);
    });
  });
});
