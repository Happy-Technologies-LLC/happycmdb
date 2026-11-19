// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Data Fixtures
 * Mock data for testing AI/ML engines
 */

import {
  AnomalyType,
  AnomalySeverity,
  AnomalyStatus,
  BaselineSnapshot,
} from '../../src/types/anomaly.types';
import {
  ChangeType,
  RiskLevel,
  ImpactType,
  AffectedCI,
} from '../../src/types/impact.types';

// Mock CI Data
export const mockCIs = {
  webServer: {
    id: 'ci-web-001',
    name: 'web-server-prod-01',
    ci_type: 'server',
    ip_address: '10.0.1.100',
    hostname: 'web-prod-01.example.com',
    status: 'active',
    environment: 'production',
  },
  database: {
    id: 'ci-db-001',
    name: 'postgres-prod-01',
    ci_type: 'database',
    ip_address: '10.0.2.50',
    hostname: 'db-prod-01.example.com',
    status: 'active',
    environment: 'production',
  },
  loadBalancer: {
    id: 'ci-lb-001',
    name: 'nginx-lb-prod',
    ci_type: 'load-balancer',
    ip_address: '10.0.1.10',
    hostname: 'lb-prod.example.com',
    status: 'active',
    environment: 'production',
  },
  orphanedCI: {
    id: 'ci-orphan-001',
    name: 'abandoned-server',
    ci_type: 'server',
    created_at: new Date('2024-01-01'),
  },
};

// Mock Change Statistics (for anomaly detection)
// Note: We need enough normal data points so the outlier has a Z-score > 2
// and confidence (abs(z) * 30) >= min_confidence_score (default 70).
export const mockChangeStatistics = {
  normal: [
    { ci_id: 'ci-001', change_count: '10', ci_name: 'server-01' },
    { ci_id: 'ci-002', change_count: '12', ci_name: 'server-02' },
    { ci_id: 'ci-003', change_count: '8', ci_name: 'server-03' },
    { ci_id: 'ci-004', change_count: '15', ci_name: 'server-04' },
    { ci_id: 'ci-005', change_count: '11', ci_name: 'server-05' },
    { ci_id: 'ci-006', change_count: '9', ci_name: 'server-06' },
    { ci_id: 'ci-007', change_count: '13', ci_name: 'server-07' },
    { ci_id: 'ci-008', change_count: '10', ci_name: 'server-08' },
  ],
  withAnomalies: [
    { ci_id: 'ci-001', change_count: '10', ci_name: 'server-01' },
    { ci_id: 'ci-002', change_count: '12', ci_name: 'server-02' },
    { ci_id: 'ci-003', change_count: '8', ci_name: 'server-03' },
    { ci_id: 'ci-004', change_count: '15', ci_name: 'server-04' },
    { ci_id: 'ci-005', change_count: '11', ci_name: 'server-05' },
    { ci_id: 'ci-006', change_count: '9', ci_name: 'server-06' },
    { ci_id: 'ci-007', change_count: '13', ci_name: 'server-07' },
    { ci_id: 'ci-008', change_count: '10', ci_name: 'server-08' },
    { ci_id: 'ci-009', change_count: '11', ci_name: 'server-09' },
    { ci_id: 'ci-010', change_count: '12', ci_name: 'server-10' },
    { ci_id: 'ci-011', change_count: '10', ci_name: 'server-11' },
    { ci_id: 'ci-012', change_count: '9', ci_name: 'server-12' },
    { ci_id: 'ci-013', change_count: '14', ci_name: 'server-13' },
    { ci_id: 'ci-014', change_count: '10', ci_name: 'server-14' },
    { ci_id: 'ci-015', change_count: '11', ci_name: 'server-15' },
    { ci_id: 'ci-016', change_count: '13', ci_name: 'server-16' },
    { ci_id: 'ci-017', change_count: '10', ci_name: 'server-17' },
    { ci_id: 'ci-018', change_count: '12', ci_name: 'server-18' },
    { ci_id: 'ci-019', change_count: '11', ci_name: 'server-19' },
    { ci_id: 'ci-020', change_count: '10', ci_name: 'server-20' },
    { ci_id: 'ci-anomaly-001', change_count: '500', ci_name: 'unstable-server' }, // Anomaly!
  ],
};

// Mock Baseline Snapshots
export const mockBaselineSnapshots: Record<string, BaselineSnapshot> = {
  configuration: {
    id: 'baseline-001',
    ci_id: 'ci-web-001',
    snapshot_type: 'configuration',
    snapshot_data: {
      name: 'web-server-prod-01',
      ci_type: 'server',
      ip_address: '10.0.1.100',
      hostname: 'web-prod-01.example.com',
      version: '2.0.1',
      port: 8080,
      max_connections: 100,
    },
    created_at: new Date('2024-10-01'),
    created_by: 'admin',
    is_approved: true,
    approved_by: 'admin',
    approved_at: new Date('2024-10-01'),
  },
  performance: {
    id: 'baseline-002',
    ci_id: 'ci-web-001',
    snapshot_type: 'performance',
    snapshot_data: {
      cpu_usage: { average: 45.2, max: 78.5 },
      memory_usage: { average: 62.1, max: 85.3 },
      response_time_ms: { average: 120, max: 350 },
    },
    created_at: new Date('2024-10-01'),
    created_by: 'system',
    is_approved: true,
  },
};

// Mock Drifted Configurations
export const mockDriftedConfig = {
  noChange: {
    name: 'web-server-prod-01',
    ci_type: 'server',
    ip_address: '10.0.1.100',
    hostname: 'web-prod-01.example.com',
    version: '2.0.1',
    port: 8080,
    max_connections: 100,
  },
  minorDrift: {
    name: 'web-server-prod-01',
    ci_type: 'server',
    ip_address: '10.0.1.100',
    hostname: 'web-prod-01.example.com',
    version: '2.0.2', // Version changed (minor)
    port: 8080,
    max_connections: 150, // Max connections changed
  },
  criticalDrift: {
    name: 'web-server-prod-01',
    ci_type: 'server',
    ip_address: '10.0.1.200', // IP changed (critical!)
    hostname: 'web-prod-02.example.com', // Hostname changed (critical!)
    version: '3.0.0',
    port: 9090,
    max_connections: 200,
  },
  fieldAdded: {
    name: 'web-server-prod-01',
    ci_type: 'server',
    ip_address: '10.0.1.100',
    hostname: 'web-prod-01.example.com',
    version: '2.0.1',
    port: 8080,
    max_connections: 100,
    ssl_enabled: true, // New field added
  },
  fieldRemoved: {
    name: 'web-server-prod-01',
    ci_type: 'server',
    ip_address: '10.0.1.100',
    version: '2.0.1',
    port: 8080,
    // hostname and max_connections removed
  },
};

// Mock Dependency Graph Data
export const mockDependencyGraph = {
  nodes: [
    {
      id: 'ci-lb-001',
      ci_id: 'ci-lb-001',
      ci_name: 'nginx-lb-prod',
      ci_type: 'load-balancer',
      criticality: 85,
      dependencies_count: 2,
      dependents_count: 0,
    },
    {
      id: 'ci-web-001',
      ci_id: 'ci-web-001',
      ci_name: 'web-server-prod-01',
      ci_type: 'server',
      criticality: 70,
      dependencies_count: 1,
      dependents_count: 1,
    },
    {
      id: 'ci-db-001',
      ci_id: 'ci-db-001',
      ci_name: 'postgres-prod-01',
      ci_type: 'database',
      criticality: 95,
      dependencies_count: 0,
      dependents_count: 2,
    },
  ],
  edges: [
    {
      source_id: 'ci-lb-001',
      target_id: 'ci-web-001',
      relationship_type: 'DEPENDS_ON',
      weight: 1.0,
      is_critical: true,
    },
    {
      source_id: 'ci-web-001',
      target_id: 'ci-db-001',
      relationship_type: 'DEPENDS_ON',
      weight: 1.0,
      is_critical: true,
    },
  ],
};

// Mock Affected CIs (for impact prediction)
export const mockAffectedCIs: AffectedCI[] = [
  {
    ci_id: 'ci-web-001',
    ci_name: 'web-server-prod-01',
    ci_type: 'server',
    impact_type: ImpactType.DIRECT,
    dependency_path: ['ci-db-001', 'ci-web-001'],
    hop_count: 1,
    impact_probability: 90,
    estimated_impact: 'Direct dependency - immediate impact expected',
    direction: 'downstream',
  },
  {
    ci_id: 'ci-lb-001',
    ci_name: 'nginx-lb-prod',
    ci_type: 'load-balancer',
    impact_type: ImpactType.INDIRECT,
    dependency_path: ['ci-db-001', 'ci-web-001', 'ci-lb-001'],
    hop_count: 2,
    impact_probability: 70,
    estimated_impact: 'Indirect impact through 1 intermediary',
    direction: 'downstream',
  },
  {
    ci_id: 'ci-app-001',
    ci_name: 'api-gateway',
    ci_type: 'application',
    impact_type: ImpactType.INDIRECT,
    dependency_path: ['ci-db-001', 'ci-web-001', 'ci-lb-001', 'ci-app-001'],
    hop_count: 3,
    impact_probability: 50,
    estimated_impact: 'Indirect impact through 2 intermediaries',
    direction: 'downstream',
  },
];

// Mock Time-Series Metrics
export const mockTimeSeriesMetrics = [
  { metric_name: 'cpu_usage', avg_value: '45.2', max_value: '78.5' },
  { metric_name: 'memory_usage', avg_value: '62.1', max_value: '85.3' },
  { metric_name: 'response_time_ms', avg_value: '120', max_value: '350' },
  { metric_name: 'error_rate', avg_value: '0.5', max_value: '2.1' },
];

// Mock Neo4j Session Results
export const createMockNeo4jRecord = (data: Record<string, any>) => ({
  get: (key: string) => {
    const value = data[key];
    // Handle Neo4j Integer type
    if (typeof value === 'number' && Number.isInteger(value)) {
      return {
        toNumber: () => value,
        toInt: () => value,
      };
    }
    // Handle node properties
    if (key === 'ci' && data.ci) {
      return {
        properties: data.ci,
      };
    }
    return value;
  },
  keys: Object.keys(data),
});

export const createMockNeo4jSession = (mockResults: any[] = []) => ({
  run: jest.fn().mockResolvedValue({
    records: mockResults.map(createMockNeo4jRecord),
  }),
  close: jest.fn().mockResolvedValue(undefined),
});

// Mock PostgreSQL Query Results
export const createMockPgClient = (mockResults: any[] = []) => ({
  query: jest.fn().mockResolvedValue({
    rows: mockResults,
    rowCount: mockResults.length,
  }),
});

// Mock Event Producer
export const createMockEventProducer = () => ({
  emit: jest.fn().mockResolvedValue(undefined),
});

// Export all fixtures
export const fixtures = {
  mockCIs,
  mockChangeStatistics,
  mockBaselineSnapshots,
  mockDriftedConfig,
  mockDependencyGraph,
  mockAffectedCIs,
  mockTimeSeriesMetrics,
  createMockNeo4jRecord,
  createMockNeo4jSession,
  createMockPgClient,
  createMockEventProducer,
};
