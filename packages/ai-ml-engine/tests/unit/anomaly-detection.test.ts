// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Anomaly Detection Engine Unit Tests
 * Tests for ML-based anomaly detection using statistical analysis
 */

import {
  AnomalyType,
  AnomalySeverity,
  AnomalyStatus,
} from '../../src/types/anomaly.types';
import {
  mockChangeStatistics,
  mockCIs,
  createMockNeo4jSession,
  createMockPgClient,
  createMockEventProducer,
} from '../fixtures/test-data';

// Mock dependencies
jest.mock('@cmdb/database');
jest.mock('@cmdb/event-processor');
jest.mock('uuid', () => ({ v4: () => 'test-uuid-123' }));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { getEventProducer } from '@cmdb/event-processor';

// We must import the class AFTER mocks are set up
import { AnomalyDetectionEngine } from '../../src/engines/anomaly-detection-engine';

describe('AnomalyDetectionEngine', () => {
  let engine: AnomalyDetectionEngine;
  let mockNeo4jClient: any;
  let mockPgClient: any;
  let mockEventProducer: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Reset singleton so each test gets fresh instance with fresh mocks
    (AnomalyDetectionEngine as any).instance = undefined;

    // Setup mock clients
    mockNeo4jClient = {
      getSession: jest.fn().mockReturnValue(createMockNeo4jSession([])),
      listCIIncarnations: jest.fn().mockResolvedValue([]),
    };
    mockPgClient = createMockPgClient([]);
    mockEventProducer = createMockEventProducer();

    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getPostgresClient as jest.Mock).mockReturnValue(mockPgClient);
    (getEventProducer as jest.Mock).mockReturnValue(mockEventProducer);

    // Get singleton instance (will be created fresh due to reset above)
    engine = AnomalyDetectionEngine.getInstance();
  });

  describe('loadConfiguration', () => {
    it('should load configuration from database', async () => {
      const mockConfig = {
        enabled: true,
        sensitivity: 'high',
        min_confidence_score: 80,
        check_interval_minutes: 30,
        lookback_days: 14,
        notification_enabled: true,
      };

      mockPgClient.query.mockResolvedValueOnce({
        rows: [{ config_value: mockConfig }],
      });

      await engine.loadConfiguration();

      expect(mockPgClient.query).toHaveBeenCalledWith(
        'SELECT config_value FROM system_config WHERE config_key = $1',
        ['anomaly_detection']
      );
    });

    it('should use default configuration if none exists in database', async () => {
      mockPgClient.query.mockResolvedValueOnce({ rows: [] });

      await engine.loadConfiguration();

      expect(mockPgClient.query).toHaveBeenCalled();
      // Should not throw error
    });
  });

  describe('detectChangeFrequencyAnomalies', () => {
    it('should detect excessive changes using statistical analysis', async () => {
      // Mock database query for change statistics
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: mockChangeStatistics.withAnomalies,
        })
        .mockResolvedValue({ rows: [] }); // For storeAnomaly and other queries

      const anomalies = await engine.detectAnomalies();

      // Should detect the server with 150 changes (anomaly) vs normal ~10 changes
      const excessiveChangeAnomaly = anomalies.find(
        a => a.anomaly_type === AnomalyType.EXCESSIVE_CHANGES
      );

      expect(excessiveChangeAnomaly).toBeDefined();
      expect(excessiveChangeAnomaly?.ci_id).toBe('ci-anomaly-001');
      // With 20+ normal CIs (~10 changes each) and one at 500, Z-score > 4 => CRITICAL
      expect(excessiveChangeAnomaly?.severity).toBe(AnomalySeverity.CRITICAL);
      expect(excessiveChangeAnomaly?.confidence_score).toBeGreaterThan(70);
    });

    it('should not detect anomalies when all changes are normal', async () => {
      mockPgClient.query.mockResolvedValueOnce({
        rows: mockChangeStatistics.normal,
      });

      const anomalies = await engine.detectAnomalies();

      const excessiveChangeAnomalies = anomalies.filter(
        a => a.anomaly_type === AnomalyType.EXCESSIVE_CHANGES
      );

      expect(excessiveChangeAnomalies).toHaveLength(0);
    });

    it('should skip detection if sample size is too small', async () => {
      mockPgClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci-001', change_count: '10', ci_name: 'server-01' }],
      });

      const anomalies = await engine.detectAnomalies();

      const excessiveChangeAnomalies = anomalies.filter(
        a => a.anomaly_type === AnomalyType.EXCESSIVE_CHANGES
      );

      expect(excessiveChangeAnomalies).toHaveLength(0);
    });

    it('should calculate correct severity based on Z-score', async () => {
      // Z-score > 4 = CRITICAL
      // Z-score > 3 = HIGH
      // Z-score > 2 = MEDIUM
      // Z-score <= 2 = LOW

      // Need enough normal data points so the extreme outlier has Z-score > 4 (CRITICAL)
      const normalRows = Array.from({ length: 20 }, (_, i) => ({
        ci_id: `ci-${String(i + 1).padStart(3, '0')}`,
        change_count: String(10 + (i % 5)), // 10-14 range
        ci_name: `server-${String(i + 1).padStart(2, '0')}`,
      }));
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [
            ...normalRows,
            { ci_id: 'ci-critical', change_count: '500', ci_name: 'critical-server' },
          ],
        })
        .mockResolvedValue({ rows: [] });

      const anomalies = await engine.detectAnomalies();

      const criticalAnomaly = anomalies.find(a => a.ci_id === 'ci-critical');
      expect(criticalAnomaly?.severity).toBe(AnomalySeverity.CRITICAL);
    });
  });

  describe('detectRelationshipAnomalies', () => {
    it('should detect orphaned CIs (no relationships)', async () => {
      // The detectAnomalies method calls detectRelationshipAnomalies which calls
      // this.neo4jClient.getSession() - we need the session to return results for
      // orphaned CIs query, then empty for dependency and circular queries.
      const mockSession = {
        run: jest.fn()
          // First call: orphaned CIs query
          .mockResolvedValueOnce({
            records: [createMockNeo4jRecordLocal({
              ci_id: mockCIs.orphanedCI.id,
              ci_name: mockCIs.orphanedCI.name,
              ci_type: 'server',
            })],
          })
          // Second call: unusual dependency count query
          .mockResolvedValueOnce({ records: [] })
          // Third call: circular dependency query
          .mockResolvedValueOnce({ records: [] }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      // Also need a second session for detectConfigurationAnomalies
      const emptySession = createMockNeo4jSession([]);

      mockNeo4jClient.getSession
        .mockReturnValueOnce(mockSession)
        .mockReturnValueOnce(emptySession);

      // Change frequency query returns < 3 rows (skip)
      mockPgClient.query.mockResolvedValue({ rows: [] });

      const anomalies = await engine.detectAnomalies();

      const orphanedAnomaly = anomalies.find(
        a => a.anomaly_type === AnomalyType.ORPHANED_CI
      );

      expect(orphanedAnomaly).toBeDefined();
      expect(orphanedAnomaly?.ci_id).toBe(mockCIs.orphanedCI.id);
      expect(orphanedAnomaly?.severity).toBe(AnomalySeverity.MEDIUM);
      expect(orphanedAnomaly?.confidence_score).toBe(95);
    });

    it('should detect unusual dependency counts', async () => {
      const mockSession = {
        run: jest.fn()
          // First call: orphaned CIs query
          .mockResolvedValueOnce({ records: [] })
          // Second call: unusual dependency count query
          .mockResolvedValueOnce({
            records: [createMockNeo4jRecordLocal({
              ci_id: 'ci-high-deps',
              ci_name: 'server-with-many-deps',
              dep_count: 75,
            })],
          })
          // Third call: circular dependency query
          .mockResolvedValueOnce({ records: [] }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const emptySession = createMockNeo4jSession([]);
      mockNeo4jClient.getSession
        .mockReturnValueOnce(mockSession)
        .mockReturnValueOnce(emptySession);

      mockPgClient.query.mockResolvedValue({ rows: [] });

      const anomalies = await engine.detectAnomalies();

      const highDepAnomaly = anomalies.find(
        a => a.anomaly_type === AnomalyType.UNUSUAL_DEPENDENCY_COUNT
      );

      expect(highDepAnomaly).toBeDefined();
      expect(highDepAnomaly?.metrics.actual_value).toBe(75);
      expect(highDepAnomaly?.metrics.threshold_exceeded).toBe(50);
    });

    it('should detect circular dependencies', async () => {
      const mockSession = {
        run: jest.fn()
          // First call: orphaned CIs query
          .mockResolvedValueOnce({ records: [] })
          // Second call: unusual dependency count query
          .mockResolvedValueOnce({ records: [] })
          // Third call: circular dependency query
          .mockResolvedValueOnce({
            records: [createMockNeo4jRecordLocal({
              ci_id: 'ci-circular',
              ci_name: 'circular-dependency-server',
              cycle_length: 3,
            })],
          }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const emptySession = createMockNeo4jSession([]);
      mockNeo4jClient.getSession
        .mockReturnValueOnce(mockSession)
        .mockReturnValueOnce(emptySession);

      mockPgClient.query.mockResolvedValue({ rows: [] });

      const anomalies = await engine.detectAnomalies();

      const circularAnomaly = anomalies.find(
        a => a.anomaly_type === AnomalyType.CIRCULAR_DEPENDENCY
      );

      expect(circularAnomaly).toBeDefined();
      expect(circularAnomaly?.severity).toBe(AnomalySeverity.HIGH);
      expect(circularAnomaly?.confidence_score).toBe(100);
    });
  });

  describe('detectConfigurationAnomalies', () => {
    it('should detect missing required attributes', async () => {
      // First session for relationship anomalies (empty)
      const relSession = {
        run: jest.fn()
          .mockResolvedValueOnce({ records: [] })
          .mockResolvedValueOnce({ records: [] })
          .mockResolvedValueOnce({ records: [] }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      // Second session for configuration anomalies
      const configSession = createMockNeo4jSession([
        {
          ci_id: 'ci-incomplete',
          ci_name: 'incomplete-server',
          ci_type: 'server',
        },
      ]);

      mockNeo4jClient.getSession
        .mockReturnValueOnce(relSession)
        .mockReturnValueOnce(configSession);

      mockPgClient.query.mockResolvedValue({ rows: [] });

      const anomalies = await engine.detectAnomalies();

      const missingAttrAnomaly = anomalies.find(
        a => a.anomaly_type === AnomalyType.MISSING_REQUIRED_ATTRIBUTE
      );

      expect(missingAttrAnomaly).toBeDefined();
      expect(missingAttrAnomaly?.severity).toBe(AnomalySeverity.MEDIUM);
      expect(missingAttrAnomaly?.confidence_score).toBe(100);
    });
  });

  describe('storeAnomaly', () => {
    it('should store anomaly in database', async () => {
      // Provide change stats that include an anomaly
      mockPgClient.query
        .mockResolvedValueOnce({ rows: mockChangeStatistics.withAnomalies })
        .mockResolvedValue({ rows: [] });

      await engine.detectAnomalies();

      // Should have called INSERT for anomaly storage
      expect(mockPgClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO anomalies'),
        expect.any(Array)
      );
    });

    it('should emit event for high-severity anomalies', async () => {
      mockPgClient.query
        .mockResolvedValueOnce({
          rows: mockChangeStatistics.withAnomalies,
        })
        .mockResolvedValue({ rows: [] });

      await engine.detectAnomalies();

      // Should emit event for the critical anomaly
      expect(mockEventProducer.emit).toHaveBeenCalled();
    });

    it('should not emit event for low-severity anomalies', async () => {
      // Return data that produces only MEDIUM severity anomalies (relationship-based)
      // Change freq returns < 3 rows (skip)
      mockPgClient.query.mockResolvedValue({ rows: [] });

      // Relationship anomalies session: return orphaned CI (MEDIUM severity, no event emitted)
      const relSession = {
        run: jest.fn()
          .mockResolvedValueOnce({
            records: [createMockNeo4jRecordLocal({
              ci_id: 'ci-low',
              ci_name: 'low-severity-ci',
              ci_type: 'server',
            })],
          })
          .mockResolvedValueOnce({ records: [] })
          .mockResolvedValueOnce({ records: [] }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const configSession = createMockNeo4jSession([]);

      mockNeo4jClient.getSession
        .mockReturnValueOnce(relSession)
        .mockReturnValueOnce(configSession);

      await engine.detectAnomalies();

      // Should not emit event for MEDIUM severity
      expect(mockEventProducer.emit).not.toHaveBeenCalled();
    });
  });

  describe('getAnomaliesForCI', () => {
    it('should retrieve anomalies for specific CI', async () => {
      const mockAnomalies = [
        {
          id: 'anomaly-1',
          ci_id: 'ci-001',
          ci_name: 'test-server',
          anomaly_type: AnomalyType.EXCESSIVE_CHANGES,
          severity: AnomalySeverity.HIGH,
          confidence_score: 85,
          detected_at: new Date(),
          description: 'Test',
          metrics: {},
          context: {},
          status: AnomalyStatus.DETECTED,
        },
      ];

      mockPgClient.query.mockResolvedValueOnce({ rows: mockAnomalies });

      const result = await engine.getAnomaliesForCI('ci-001', 10);

      expect(result).toHaveLength(1);
      expect(result[0].ci_id).toBe('ci-001');
      expect(mockPgClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE ci_id = $1'),
        ['ci-001', 10]
      );
    });
  });

  describe('getRecentAnomalies', () => {
    it('should retrieve recent anomalies within time window', async () => {
      const mockAnomalies = [
        {
          id: 'anomaly-1',
          ci_id: 'ci-001',
          ci_name: 'server-1',
          anomaly_type: AnomalyType.EXCESSIVE_CHANGES,
          severity: AnomalySeverity.HIGH,
          confidence_score: 85,
          detected_at: new Date(),
          description: 'Recent anomaly',
          metrics: {},
          context: {},
          status: AnomalyStatus.DETECTED,
        },
      ];

      mockPgClient.query.mockResolvedValueOnce({ rows: mockAnomalies });

      const result = await engine.getRecentAnomalies(24, 50);

      expect(result).toHaveLength(1);
      expect(mockPgClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INTERVAL '24 hours'"),
        [50]
      );
    });
  });

  describe('sensitivity settings', () => {
    it('should detect more anomalies with high sensitivity', async () => {
      const configWithHighSensitivity = {
        enabled: true,
        sensitivity: 'high' as const,
        min_confidence_score: 60,
        check_interval_minutes: 30,
        lookback_days: 30,
        notification_enabled: true,
      };

      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [{ config_value: configWithHighSensitivity }],
        })
        .mockResolvedValueOnce({
          rows: mockChangeStatistics.withAnomalies,
        })
        .mockResolvedValue({ rows: [] });

      await engine.loadConfiguration();
      const anomalies = await engine.detectAnomalies();

      // High sensitivity should detect anomalies with lower threshold
      expect(anomalies.length).toBeGreaterThan(0);
    });

    it('should detect fewer anomalies with low sensitivity', async () => {
      const configWithLowSensitivity = {
        enabled: true,
        sensitivity: 'low' as const,
        min_confidence_score: 90,
        check_interval_minutes: 30,
        lookback_days: 30,
        notification_enabled: true,
      };

      mockPgClient.query
        .mockResolvedValueOnce({
          rows: [{ config_value: configWithLowSensitivity }],
        })
        .mockResolvedValueOnce({
          rows: mockChangeStatistics.normal,
        })
        .mockResolvedValue({ rows: [] });

      await engine.loadConfiguration();
      const anomalies = await engine.detectAnomalies();

      // Low sensitivity should not detect anomalies in normal data
      expect(anomalies.filter(a => a.anomaly_type === AnomalyType.EXCESSIVE_CHANGES)).toHaveLength(0);
    });
  });

  describe('disabled detection', () => {
    it('should skip detection when disabled', async () => {
      const disabledConfig = {
        enabled: false,
        sensitivity: 'medium' as const,
        min_confidence_score: 70,
        check_interval_minutes: 60,
        lookback_days: 30,
        notification_enabled: false,
      };

      mockPgClient.query.mockResolvedValueOnce({
        rows: [{ config_value: disabledConfig }],
      });

      await engine.loadConfiguration();
      const anomalies = await engine.detectAnomalies();

      expect(anomalies).toHaveLength(0);
      expect(mockPgClient.query).toHaveBeenCalledTimes(1); // Only config load
    });
  });
});

// Local helper - same logic as createMockNeo4jRecord from fixtures but available here
function createMockNeo4jRecordLocal(data: Record<string, any>) {
  return {
    get: (key: string) => {
      const value = data[key];
      if (typeof value === 'number' && Number.isInteger(value)) {
        return {
          toNumber: () => value,
          toInt: () => value,
        };
      }
      if (key === 'ci' && data.ci) {
        return {
          properties: data.ci,
        };
      }
      return value;
    },
    keys: Object.keys(data),
  };
}
