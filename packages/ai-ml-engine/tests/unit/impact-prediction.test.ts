// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Prediction Engine Unit Tests
 * Tests for dependency graph analysis and change impact assessment
 */

import {
  ChangeType,
  RiskLevel,
  ImpactType,
} from '../../src/types/impact.types';
import {
  mockCIs,
  mockDependencyGraph,
  createMockNeo4jSession,
  createMockNeo4jRecord,
  createMockPgClient,
} from '../fixtures/test-data';

// Mock dependencies
jest.mock('@cmdb/database');
jest.mock('uuid', () => ({ v4: () => 'impact-test-uuid' }));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';

import { ImpactPredictionEngine } from '../../src/engines/impact-prediction-engine';
const INC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('ImpactPredictionEngine', () => {
  let engine: ImpactPredictionEngine;
  let mockNeo4jClient: any;
  let mockPgClient: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset singleton
    (ImpactPredictionEngine as any).instance = undefined;

    mockNeo4jClient = {
      getCI: jest.fn().mockImplementation(async (id: string) =>
        id.includes('nonexistent') ? null : { id, _incarnation_id: INC }
      ),
      ensureCIIncarnation: jest.fn().mockResolvedValue(INC),
      getSession: jest.fn(),
    };
    mockPgClient = createMockPgClient([]);

    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getPostgresClient as jest.Mock).mockReturnValue(mockPgClient);

    engine = ImpactPredictionEngine.getInstance();
  });

  /** Prediction owns a CI lookup session and two bounded-frontier sessions. */
  function setupPredictImpactMocks(opts: {
    ciData: Record<string, any>;
    affectedRecords: Record<string, any>[];
    criticalPath: string[];
    criticalityScore: number;
    ciId: string;
  }) {
    const ciSession = createMockNeo4jSession([opts.ciData]);
    const depSession = createMockNeo4jSession([]);
    depSession.run.mockImplementation(async (_query: string, params: { frontier: string[] }) => ({
      records: opts.affectedRecords
        .filter(row => params.frontier.includes(row.path_ids[row.path_ids.length - 2]))
        .map(row => createMockNeo4jRecord({
          ci_id: row.ci_id, ci_name: row.ci_name, ci_type: row.ci_type,
          parent_id: row.path_ids[row.path_ids.length - 2],
        })),
    }));
    const pathSession = createMockNeo4jSession([]);
    pathSession.run.mockImplementation(async (_query: string, params: { frontier: string[] }) => ({
      records: opts.criticalPath.slice(1)
        .filter((id, index) => params.frontier.includes(opts.criticalPath[index]))
        .map(id => createMockNeo4jRecord({
          ci_id: id, ci_name: id, ci_type: 'server',
          parent_id: opts.criticalPath[opts.criticalPath.indexOf(id) - 1],
        })),
    }));
    mockNeo4jClient.getSession
      .mockReturnValueOnce(ciSession)
      .mockReturnValueOnce(depSession)
      .mockReturnValueOnce(pathSession)
      .mockReturnValue(createMockNeo4jSession([]));
    mockPgClient.query
      .mockResolvedValueOnce({
        rows: [{
          ci_id: opts.ciId,
          ci_name: opts.ciData.name,
          criticality_score: opts.criticalityScore,
          factors: {},
          calculated_at: new Date(),
        }],
      })
      .mockResolvedValue({ rows: [{ id: 'impact-test-uuid' }] });
  }

  describe('predictChangeImpact', () => {
    it('should predict impact for database change with downstream dependencies', async () => {
      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords: [
          {
            ci_id: mockCIs.webServer.id,
            ci_name: mockCIs.webServer.name,
            ci_type: mockCIs.webServer.ci_type,
            hop_count: 1,
            path_ids: [mockCIs.database.id, mockCIs.webServer.id],
          },
          {
            ci_id: mockCIs.loadBalancer.id,
            ci_name: mockCIs.loadBalancer.name,
            ci_type: mockCIs.loadBalancer.ci_type,
            hop_count: 2,
            path_ids: [mockCIs.database.id, mockCIs.webServer.id, mockCIs.loadBalancer.id],
          },
        ],
        criticalPath: [mockCIs.database.id, mockCIs.webServer.id, mockCIs.loadBalancer.id],
        criticalityScore: 95,
        ciId: mockCIs.database.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.VERSION_UPGRADE, 'org-a');

      expect(impact).toBeDefined();
      expect(impact.source_ci_id).toBe(mockCIs.database.id);
      expect(impact.change_type).toBe(ChangeType.VERSION_UPGRADE);
      expect(impact.blast_radius).toBe(2); // Web server + load balancer
      expect(impact.affected_cis).toHaveLength(2);
      expect(impact.risk_level).toBeDefined();
      expect(impact.impact_score).toBeGreaterThan(0);
      expect(impact.critical_path).toEqual([
        mockCIs.database.id, mockCIs.webServer.id, mockCIs.loadBalancer.id,
      ]);
    });

    it('should calculate CRITICAL risk for decommission with large blast radius', async () => {
      const affectedRecords = Array.from({ length: 60 }, (_, i) => ({
        ci_id: `ci-affected-${i}`,
        ci_name: `affected-server-${i}`,
        ci_type: 'server',
        hop_count: 1,
        path_ids: [mockCIs.database.id, `ci-affected-${i}`],
      }));

      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords,
        criticalPath: [mockCIs.database.id, 'ci-affected-0'],
        criticalityScore: 95,
        ciId: mockCIs.database.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.DECOMMISSION, 'org-a');

      expect(impact.risk_level).toBe(RiskLevel.CRITICAL);
      expect(impact.blast_radius).toBe(60);
      expect(impact.estimated_downtime_minutes).toBeGreaterThan(0);
    });

    it('should calculate LOW risk for configuration change with minimal impact', async () => {
      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.webServer.id,
          name: mockCIs.webServer.name,
          ci_type: mockCIs.webServer.ci_type,
        },
        affectedRecords: [
          {
            ci_id: mockCIs.loadBalancer.id,
            ci_name: mockCIs.loadBalancer.name,
            ci_type: mockCIs.loadBalancer.ci_type,
            hop_count: 1,
            path_ids: [mockCIs.webServer.id, mockCIs.loadBalancer.id],
          },
        ],
        criticalPath: [mockCIs.webServer.id, mockCIs.loadBalancer.id],
        criticalityScore: 30,
        ciId: mockCIs.webServer.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.webServer.id, ChangeType.CONFIGURATION_CHANGE, 'org-a');

      expect(impact.risk_level).toBe(RiskLevel.MINIMAL);
      expect(impact.blast_radius).toBe(1);
    });

    it('should distinguish between direct and indirect impact', async () => {
      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords: [
          {
            ci_id: mockCIs.webServer.id,
            ci_name: mockCIs.webServer.name,
            ci_type: mockCIs.webServer.ci_type,
            hop_count: 1, // Direct
            path_ids: [mockCIs.database.id, mockCIs.webServer.id],
          },
          {
            ci_id: mockCIs.loadBalancer.id,
            ci_name: mockCIs.loadBalancer.name,
            ci_type: mockCIs.loadBalancer.ci_type,
            hop_count: 2, // Indirect
            path_ids: [mockCIs.database.id, mockCIs.webServer.id, mockCIs.loadBalancer.id],
          },
        ],
        criticalPath: [mockCIs.database.id, mockCIs.webServer.id],
        criticalityScore: 80,
        ciId: mockCIs.database.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.RESTART, 'org-a');

      const directImpact = impact.affected_cis.find(
        ci => ci.ci_id === mockCIs.webServer.id
      );
      const indirectImpact = impact.affected_cis.find(
        ci => ci.ci_id === mockCIs.loadBalancer.id
      );

      expect(directImpact?.impact_type).toBe(ImpactType.DIRECT);
      expect(directImpact?.hop_count).toBe(1);
      expect(directImpact?.impact_probability).toBe(90);

      expect(indirectImpact?.impact_type).toBe(ImpactType.INDIRECT);
      expect(indirectImpact?.hop_count).toBe(2);
      expect(indirectImpact?.impact_probability).toBeLessThan(90);
    });

    it('should throw error for non-existent CI', async () => {
      const ciSession = createMockNeo4jSession([]);

      mockNeo4jClient.getSession.mockReturnValue(ciSession);

      await expect(
        engine.predictChangeImpact('ci-nonexistent', ChangeType.RESTART, 'org-a')
      ).rejects.toThrow('CI not found');
    });
  });

  describe('calculateCriticalityScore', () => {
    it('should calculate high criticality for CI with many dependents', async () => {
      // getCriticalityScore first checks postgres cache (no cache)
      // then calculateCriticalityScore opens neo4j session
      // then getChangeFrequency queries postgres
      // then storeCriticalityScore queries postgres
      const depSession = createMockNeo4jSession([
        {
          ci_id: mockCIs.database.id,
          ci_name: mockCIs.database.name,
          dependent_count: 50,
          dependency_count: 0,
          dependent_ids: [],
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(depSession);
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [] }) // No cached score
        .mockResolvedValueOnce({ rows: [{ change_count: '5' }] }) // Change frequency
        .mockResolvedValue({ rows: [{ ci_id: mockCIs.database.id }] }); // storeCriticalityScore

      const score = await engine.getCriticalityScore(mockCIs.database.id, 'org-a');

      expect(score.criticality_score).toBeGreaterThan(70);
      expect(score.factors.dependent_count).toBe(50);
    });

    it('should calculate low criticality for isolated CI', async () => {
      const depSession = createMockNeo4jSession([
        {
          ci_id: 'ci-isolated',
          ci_name: 'isolated-server',
          dependent_count: 0,
          dependency_count: 0,
          dependent_ids: [],
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(depSession);
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ change_count: '2' }] })
        .mockResolvedValue({ rows: [{ ci_id: 'ci-isolated' }] });

      const score = await engine.getCriticalityScore('ci-isolated', 'org-a');

      expect(score.criticality_score).toBeLessThan(50);
      expect(score.factors.dependent_count).toBe(0);
    });

    it('should use cached criticality score if recent', async () => {
      const cachedScore = {
        ci_id: mockCIs.database.id,
        ci_name: mockCIs.database.name,
        criticality_score: 85,
        factors: {
          dependent_count: 40,
          dependent_weight: 100,
          change_frequency: 10,
          failure_history: 0,
          business_impact: 50,
        },
        calculated_at: new Date(),
      };

      mockPgClient.query.mockResolvedValueOnce({ rows: [cachedScore] });

      const score = await engine.getCriticalityScore(mockCIs.database.id, 'org-a');

      expect(score.criticality_score).toBe(85);
      expect(mockNeo4jClient.getSession).not.toHaveBeenCalled(); // Should not recalculate
    });

    it('should factor in change frequency (lower is better)', async () => {
      // First: stable CI
      const depSession1 = createMockNeo4jSession([
        {
          ci_id: 'ci-stable',
          ci_name: 'stable-server',
          dependent_count: 2,
          dependency_count: 0,
          dependent_ids: [],
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(depSession1);
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ change_count: '1' }] }) // Very stable
        .mockResolvedValue({ rows: [{ ci_id: 'ci-stable' }] });

      const stableScore = await engine.getCriticalityScore('ci-stable', 'org-a');

      // Reset for unstable CI - need a fresh singleton
      jest.clearAllMocks();
      (ImpactPredictionEngine as any).instance = undefined;
      (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
      (getPostgresClient as jest.Mock).mockReturnValue(mockPgClient);
      engine = ImpactPredictionEngine.getInstance();

      const depSession2 = createMockNeo4jSession([
        {
          ci_id: 'ci-unstable',
          ci_name: 'unstable-server',
          dependent_count: 2,
          dependency_count: 0,
          dependent_ids: [],
        },
      ]);

      mockNeo4jClient.getSession.mockReturnValue(depSession2);
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ change_count: '50' }] }) // Very unstable
        .mockResolvedValue({ rows: [{ ci_id: 'ci-unstable' }] });

      const unstableScore = await engine.getCriticalityScore('ci-unstable', 'org-a');

      // Stable CIs should have higher criticality (more reliable = more critical)
      expect(stableScore.criticality_score).toBeGreaterThan(unstableScore.criticality_score);
    });
  });

  describe('buildDependencyGraph', () => {
    it('rejects excessive depth from direct engine callers before graph work', async () => {
      await expect(engine.buildDependencyGraph(mockCIs.database.id, 6, 'org-a'))
        .rejects.toThrow('Impact criticality resource limit exceeded');
      expect(mockNeo4jClient.getSession).not.toHaveBeenCalled();
    });

    const graphSession = (
      nodes = mockDependencyGraph.nodes,
      graphEdges = mockDependencyGraph.edges
    ) => {
      const session = createMockNeo4jSession([]);
      session.run.mockImplementation(async (cypher: string, params: { frontier?: string[]; nodeIds?: string[] }) => ({
        records: cypher.includes('RETURN node.id as id')
          ? nodes.filter(node => params.nodeIds?.includes(node.ci_id)).map(node => createMockNeo4jRecord({
              id: node.ci_id, name: node.ci_name, ci_type: node.ci_type,
              dependents_count: node.dependents_count, dependencies_count: node.dependencies_count,
            }))
          : graphEdges.flatMap((edge, i) => {
              const fromSource = params.frontier?.includes(edge.source_id);
              const fromTarget = params.frontier?.includes(edge.target_id);
              return [fromSource && edge.target_id, fromTarget && edge.source_id]
                .filter((id): id is string => typeof id === 'string')
                .map(id => createMockNeo4jRecord({
                  rel_id: `rel-${i}`, source_id: edge.source_id, target_id: edge.target_id,
                  rel_type: edge.relationship_type, neighbor_id: id,
                }));
            }),
      }));
      return session;
    };

    it('should build complete dependency graph', async () => {
      const session = graphSession();
      mockNeo4jClient.getSession.mockReturnValue(session);

      // Mock criticality scores for each node
      mockPgClient.query.mockImplementation((query: string, params: any[]) => {
        const ciId = params?.[0];
        const node = mockDependencyGraph.nodes.find(n => n.ci_id === ciId);
        if (node && query.includes('ci_criticality_scores')) {
          return Promise.resolve({
            rows: [{
              ci_id: node.ci_id,
              ci_name: node.ci_name,
              criticality_score: node.criticality,
              factors: {},
              calculated_at: new Date(),
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const graph = await engine.buildDependencyGraph(mockCIs.database.id, 3, 'org-a');

      expect(graph.nodes.map(node => [node.ci_id, node.criticality]).sort()).toEqual([
        ['ci-db-001', 95], ['ci-lb-001', 85], ['ci-web-001', 70],
      ]);
      expect(graph.edges).toEqual(mockDependencyGraph.edges.slice().reverse());
      expect(graph.metadata).toMatchObject({ total_nodes: 3, total_edges: 2, max_depth: 3 });
    });

    it('should respect max depth parameter', async () => {
      const session = graphSession();
      mockNeo4jClient.getSession.mockReturnValue(session);
      mockPgClient.query.mockResolvedValue({
        rows: [{
          ci_id: mockCIs.database.id,
          ci_name: mockCIs.database.name,
          criticality_score: 50,
          factors: {},
          calculated_at: new Date(),
        }],
      });

      const first = await engine.buildDependencyGraph(mockCIs.database.id, 1, 'org-a');
      const second = await engine.buildDependencyGraph(mockCIs.database.id, 2, 'org-a');
      expect(first.nodes.map(node => node.ci_id).sort()).toEqual(['ci-db-001', 'ci-web-001']);
      expect(second.nodes.map(node => node.ci_id).sort()).toEqual(['ci-db-001', 'ci-lb-001', 'ci-web-001']);
      expect(first.metadata.max_depth).toBe(1);
      expect(second.metadata.max_depth).toBe(2);
    });
  });

  describe('getImpactHistory', () => {
    it('should retrieve impact analysis history for a CI', async () => {
      const mockHistory = [
        {
          id: 'impact-001',
          source_ci_id: mockCIs.database.id,
          source_ci_name: mockCIs.database.name,
          change_type: ChangeType.RESTART,
          impact_score: 40,
          affected_cis: [],
          blast_radius: 2,
          critical_path: [mockCIs.database.id],
          risk_level: RiskLevel.LOW,
          analyzed_at: new Date(),
          estimated_downtime_minutes: 9,
        },
      ];

      mockPgClient.query.mockResolvedValueOnce({ rows: mockHistory });

      const result = await engine.getImpactHistory(mockCIs.database.id, 10, 'org-a');

      expect(result).toHaveLength(1);
      expect(result[0].source_ci_id).toBe(mockCIs.database.id);
      expect(result[0].risk_level).toBe(RiskLevel.LOW);
    });

    it('should return an empty array when no history exists', async () => {
      mockPgClient.query.mockResolvedValueOnce({ rows: [] });

      const result = await engine.getImpactHistory('ci-no-history', 10, 'org-a');

      expect(result).toEqual([]);
    });
  });

  describe('estimateDowntime', () => {
    it('should estimate downtime for RESTART', async () => {
      const affectedRecords = Array.from({ length: 10 }, (_, i) => ({
        ci_id: `ci-${i}`,
        ci_name: `server-${i}`,
        ci_type: 'server',
        hop_count: 1,
        path_ids: [mockCIs.database.id, `ci-${i}`],
      }));

      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords,
        criticalPath: [mockCIs.database.id, 'ci-0'],
        criticalityScore: 80,
        ciId: mockCIs.database.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.RESTART, 'org-a');

      expect(impact.estimated_downtime_minutes).toBeDefined();
      expect(impact.estimated_downtime_minutes).toBeGreaterThan(0);
      // RESTART formula: 5 + blastRadius * 2
      expect(impact.estimated_downtime_minutes).toBe(5 + 10 * 2);
    });

    it('should estimate higher downtime for VERSION_UPGRADE', async () => {
      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords: [
          {
            ci_id: mockCIs.webServer.id,
            ci_name: mockCIs.webServer.name,
            ci_type: mockCIs.webServer.ci_type,
            hop_count: 1,
            path_ids: [mockCIs.database.id, mockCIs.webServer.id],
          },
        ],
        criticalPath: [mockCIs.database.id, mockCIs.webServer.id],
        criticalityScore: 80,
        ciId: mockCIs.database.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.VERSION_UPGRADE, 'org-a');

      // VERSION_UPGRADE formula: 30 + blastRadius * 5
      expect(impact.estimated_downtime_minutes).toBe(30 + 1 * 5);
    });

    it('should not estimate downtime for CONFIGURATION_CHANGE', async () => {
      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.webServer.id,
          name: mockCIs.webServer.name,
          ci_type: mockCIs.webServer.ci_type,
        },
        affectedRecords: [],
        criticalPath: [mockCIs.webServer.id],
        criticalityScore: 50,
        ciId: mockCIs.webServer.id,
      });

      const impact = await engine.predictChangeImpact(mockCIs.webServer.id, ChangeType.CONFIGURATION_CHANGE, 'org-a');

      expect(impact.estimated_downtime_minutes).toBeUndefined();
    });
  });

  describe('change type weight', () => {
    it('should apply highest weight to DECOMMISSION', async () => {
      // Run decommission
      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords: [
          {
            ci_id: mockCIs.webServer.id,
            ci_name: mockCIs.webServer.name,
            ci_type: mockCIs.webServer.ci_type,
            hop_count: 1,
            path_ids: [mockCIs.database.id, mockCIs.webServer.id],
          },
        ],
        criticalPath: [mockCIs.database.id, mockCIs.webServer.id],
        criticalityScore: 80,
        ciId: mockCIs.database.id,
      });

      const decommissionImpact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.DECOMMISSION, 'org-a');

      // Reset for config change - need fresh singleton
      jest.clearAllMocks();
      (ImpactPredictionEngine as any).instance = undefined;
      (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
      (getPostgresClient as jest.Mock).mockReturnValue(mockPgClient);
      engine = ImpactPredictionEngine.getInstance();

      setupPredictImpactMocks({
        ciData: {
          id: mockCIs.database.id,
          name: mockCIs.database.name,
          ci_type: mockCIs.database.ci_type,
        },
        affectedRecords: [
          {
            ci_id: mockCIs.webServer.id,
            ci_name: mockCIs.webServer.name,
            ci_type: mockCIs.webServer.ci_type,
            hop_count: 1,
            path_ids: [mockCIs.database.id, mockCIs.webServer.id],
          },
        ],
        criticalPath: [mockCIs.database.id, mockCIs.webServer.id],
        criticalityScore: 80,
        ciId: mockCIs.database.id,
      });

      const configChangeImpact = await engine.predictChangeImpact(mockCIs.database.id, ChangeType.CONFIGURATION_CHANGE, 'org-a');

      // Decommission should have higher impact score than config change
      expect(decommissionImpact.impact_score).toBeGreaterThan(configChangeImpact.impact_score);
    });
  });
});
