// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Prediction Engine
 * Dependency graph analysis for change impact assessment
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import {
  ImpactAnalysis,
  ChangeType,
  RiskLevel,
  AffectedCI,
  ImpactType,
  DependencyGraph,
  GraphNode,
  GraphEdge,
  CriticalityScore,
  CriticalityFactors,
} from '../types/impact.types';
import { v4 as uuidv4 } from 'uuid';
import neo4j from 'neo4j-driver';
const IMPACT_QUERY_TIMEOUT_MS = 5000;
const MAX_CRITICALITY_DEPTH = 12;
const MAX_CRITICALITY_NODES = 100;
const MAX_IMPACT_GRAPH_NODES = 100;
const MAX_IMPACT_GRAPH_EDGES = 200;
const MAX_IMPACT_GRAPH_WORK = 400;

export class ImpactCriticalityLimitError extends Error {
  constructor() {
    super('Impact criticality resource limit exceeded');
  }
}

interface CriticalityWalk {
  active: Set<string>;
  computed: Map<string, CriticalityScore>;
  remaining: number;
  cycleDetected: boolean;
  sharedWork?: { remaining: number };
}


export class ImpactPredictionEngine {
  private static instance: ImpactPredictionEngine;
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();

  private constructor() {}

  static getInstance(): ImpactPredictionEngine {
    if (!ImpactPredictionEngine.instance) {
      ImpactPredictionEngine.instance = new ImpactPredictionEngine();
    }
    return ImpactPredictionEngine.instance;
  }

  /**
   * Predict impact of a change on a CI
   */
  async predictChangeImpact(
    ciId: string,
    changeType: ChangeType,
    organizationId: string
  ): Promise<ImpactAnalysis> {
    logger.info('Predicting change impact', { ci_id: ciId, change_type: changeType });

    const session = this.neo4jClient.getSession();

    try {
      // Get source CI details
      const ciResult = await session.run(
        `MATCH (ci:CI {id: $ciId})
         WHERE ci.organization_id = $organizationId
         RETURN ci.id as id, ci.name as name, ci.ci_type as ci_type`,
        { ciId, organizationId },
        { timeout: IMPACT_QUERY_TIMEOUT_MS }
      );

      if (ciResult.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const sourceCi = ciResult.records[0];
      if (!sourceCi) {
        throw new Error(`CI record not found: ${ciId}`);
      }

      // Find all affected CIs (downstream dependencies)
      const affectedCIs = await this.findAffectedCIs(ciId, organizationId);

      // Calculate impact score based on criticality and blast radius
      const criticalityScore = await this.getCriticalityScore(ciId, organizationId);
      const impactScore = this.calculateImpactScore(
        affectedCIs.length,
        criticalityScore.criticality_score,
        changeType
      );

      // Find critical path (longest dependency chain)
      const criticalPath = await this.findCriticalPath(ciId, organizationId);

      // Determine risk level
      const riskLevel = this.determineRiskLevel(impactScore, affectedCIs.length);

      const impact: ImpactAnalysis = {
        id: uuidv4(),
        source_ci_id: ciId,
        source_ci_name: sourceCi.get('name'),
        change_type: changeType,
        impact_score: Math.round(impactScore),
        affected_cis: affectedCIs,
        blast_radius: affectedCIs.length,
        critical_path: criticalPath,
        risk_level: riskLevel,
        analyzed_at: new Date(),
        estimated_downtime_minutes: this.estimateDowntime(changeType, affectedCIs.length),
      };

      // Store impact analysis
      await this.storeImpactAnalysis(impact, organizationId);

      logger.info('Impact analysis completed', {
        impact_score: impact.impact_score,
        blast_radius: impact.blast_radius,
        risk_level: impact.risk_level,
      });

      return impact;
    } finally {
      await session.close();
    }
  }

  /**
   * Find all CIs affected by a change to source CI
   */
  private async findAffectedCIs(sourceCIId: string, organizationId: string): Promise<AffectedCI[]> {
    const session = this.neo4jClient.getSession();
    const affectedCIs: AffectedCI[] = [];

    try {
      // Find all downstream dependencies (CIs that depend on this CI)
      const result = await session.run(
        `MATCH path = (source:CI {id: $ciId})<-[*1..5]-(dependent:CI)
         WHERE ALL(n IN nodes(path) WHERE n.organization_id = $organizationId)
           AND ALL(r IN relationships(path) WHERE type(r) IN ['DEPENDS_ON', 'USES', 'HOSTED_ON'])
         WITH dependent, path,
              length(path) as hop_count,
              [node IN nodes(path) | node.id] as path_ids
         RETURN DISTINCT
           dependent.id as ci_id,
           dependent.name as ci_name,
           dependent.ci_type as ci_type,
           hop_count,
           path_ids
         ORDER BY hop_count
         LIMIT 200`,
        { ciId: sourceCIId, organizationId },
        { timeout: IMPACT_QUERY_TIMEOUT_MS }
      );

      for (const record of result.records) {
        const hopCount = record.get('hop_count').toNumber();
        const impactProbability = this.calculateImpactProbability(hopCount);

        affectedCIs.push({
          ci_id: record.get('ci_id'),
          ci_name: record.get('ci_name'),
          ci_type: record.get('ci_type'),
          impact_type: hopCount === 1 ? ImpactType.DIRECT : ImpactType.INDIRECT,
          dependency_path: record.get('path_ids'),
          hop_count: hopCount,
          impact_probability: Math.round(impactProbability),
          estimated_impact: this.estimateImpactDescription(hopCount),
        });
      }
    } finally {
      await session.close();
    }

    return affectedCIs;
  }

  /**
   * Find critical path (longest dependency chain)
   */
  private async findCriticalPath(ciId: string, organizationId: string): Promise<string[]> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH path = (source:CI {id: $ciId})<-[*1..10]-(dependent:CI)
         WHERE ALL(n IN nodes(path) WHERE n.organization_id = $organizationId)
           AND ALL(r IN relationships(path) WHERE type(r) = 'DEPENDS_ON')
         WITH path, length(path) as path_length
         ORDER BY path_length DESC
         LIMIT 1
         RETURN [node IN nodes(path) | node.id] as critical_path`,
        { ciId, organizationId },
        { timeout: IMPACT_QUERY_TIMEOUT_MS }
      );

      if (result.records.length > 0) {
        const firstRecord = result.records[0];
        if (firstRecord) {
          return firstRecord.get('critical_path');
        }
      }

      return [ciId];
    } finally {
      await session.close();
    }
  }

  /**
   * Get or calculate criticality score for a CI
   */
  async getCriticalityScore(ciId: string, organizationId: string): Promise<CriticalityScore> {
    const walk: CriticalityWalk = {
      active: new Set<string>(),
      computed: new Map<string, CriticalityScore>(),
      remaining: MAX_CRITICALITY_NODES,
      cycleDetected: false,
    };
    const score = await this.walkCriticality(ciId, organizationId, walk, 0);
    // A back-edge makes descendants depend on the requested root. Return the
    // bounded result, but never cache context-dependent scores from that walk.
    // Budget failures still leave no partial cache; acyclic walks persist as before.
    if (!walk.cycleDetected) {
      for (const computed of walk.computed.values()) {
        await this.storeCriticalityScore(computed, organizationId);
      }
    }
    return score;
  }

  private async walkCriticality(
    ciId: string, organizationId: string, walk: CriticalityWalk, depth: number
  ): Promise<CriticalityScore> {
    const computed = walk.computed.get(ciId);
    if (computed) return computed;
    if (depth >= MAX_CRITICALITY_DEPTH || walk.remaining === 0 || walk.sharedWork?.remaining === 0) {
      throw new ImpactCriticalityLimitError();
    }
    walk.remaining--;
    if (walk.sharedWork) walk.sharedWork.remaining--;
    walk.active.add(ciId);
    try {
      if (!await this.neo4jClient.getCI(ciId, organizationId, IMPACT_QUERY_TIMEOUT_MS)) {
        throw new Error(`CI not found: ${ciId}`);
      }
      const cached = await this.postgresClient.query(
        `SELECT s.* FROM ci_criticality_scores s
         WHERE s.ci_id = $1 AND s.calculated_at >= NOW() - INTERVAL '7 days'`,
        [ciId]
      );
      if (cached.rows.length > 0) return this.mapRowToCriticalityScore(cached.rows[0]);
      const score = await this.calculateCriticalityScore(ciId, organizationId, walk, depth);
      walk.computed.set(ciId, score);
      return score;
    } finally {
      walk.active.delete(ciId);
    }
  }

  /**
   * Calculate criticality score based on multiple factors
   */
  private async calculateCriticalityScore(
    ciId: string, organizationId: string, walk: CriticalityWalk, depth: number
  ): Promise<CriticalityScore> {
    const session = this.neo4jClient.getSession();

    try {
      // Get dependency counts and relationship weights
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         WHERE ci.organization_id = $organizationId
         OPTIONAL MATCH (ci)<-[incoming]-(dependent:CI)
         WHERE dependent.organization_id = $organizationId
         OPTIONAL MATCH (ci)-[outgoing]->(dependency:CI)
         WHERE dependency.organization_id = $organizationId
         WITH ci,
              COUNT(DISTINCT incoming) as dependent_count,
              COUNT(DISTINCT outgoing) as dependency_count,
              COLLECT(DISTINCT dependent.id) as dependent_ids
         RETURN ci.id as ci_id,
                ci.name as ci_name,
                dependent_count,
                dependency_count,
                dependent_ids`,
        { ciId, organizationId },
        { timeout: IMPACT_QUERY_TIMEOUT_MS }
      );

      if (result.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const record = result.records[0];
      if (!record) {
        throw new Error(`Failed to get dependency data for CI: ${ciId}`);
      }
      const dependentCount = record.get('dependent_count').toNumber();

      // Get change frequency
      const changeFreq = await this.getChangeFrequency(ciId);

      // Calculate dependent weight (sum of dependent criticalities)
      let dependentWeight = 0;
      const dependentIds = record.get('dependent_ids');

      for (const depId of dependentIds) {
        // A cycle edge contributes no score. The first visit still counts as a
        // dependent in the existing dependent_count factor.
        if (walk.active.has(depId)) {
          walk.cycleDetected = true;
          continue;
        }
        const depScore = await this.walkCriticality(depId, organizationId, walk, depth + 1);
        dependentWeight += depScore.criticality_score * 0.5;
      }

      const factors: CriticalityFactors = {
        dependent_count: dependentCount,
        dependent_weight: dependentWeight,
        change_frequency: changeFreq,
        failure_history: 0, // TODO: Calculate from historical data
        business_impact: 50, // Default, can be set manually
      };

      // Weighted score calculation
      const criticalityScore =
        factors.dependent_count * 10 + // High impact if many depend on it
        factors.dependent_weight * 0.3 +
        (100 - factors.change_frequency) * 0.2 + // Stable CIs are more critical
        factors.business_impact * 0.5;

      const normalizedScore = Math.min(Math.round(criticalityScore), 100);

      const score: CriticalityScore = {
        ci_id: ciId,
        ci_name: record.get('ci_name'),
        criticality_score: normalizedScore,
        factors,
        calculated_at: new Date(),
      };


      return score;
    } finally {
      await session.close();
    }
  }

  /**
   * Get change frequency for a CI (changes per month)
   */
  private async getChangeFrequency(ciId: string): Promise<number> {
    const result = await this.postgresClient.query(
      `SELECT COUNT(*) as change_count FROM ci_change_history h
       WHERE h.ci_id = $1 AND h.changed_at >= NOW() - INTERVAL '30 days'`,
      [ciId]
    );

    const firstRow = result.rows[0];
    return parseInt(firstRow?.change_count || '0');
  }

  /**
   * Build dependency graph for visualization
   */
  async buildDependencyGraph(rootCiId: string, maxDepth: number, organizationId: string): Promise<DependencyGraph> {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 5) throw new ImpactCriticalityLimitError();
    const session = this.neo4jClient.getSession();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();
    const work = { remaining: MAX_IMPACT_GRAPH_WORK };
    const reusableScores = new Map<string, CriticalityScore>();
    const pendingScores = new Map<string, CriticalityScore>();
    let cacheable = true;

    try {
      // Get nodes and relationships
      const result = await session.run(
        `MATCH path = (root:CI {id: $rootCiId})-[*0..${maxDepth}]-(related:CI)
         WHERE ALL(n IN nodes(path) WHERE n.organization_id = $organizationId)
         UNWIND nodes(path) as node
         WITH DISTINCT node
         LIMIT $nodeLimit
         OPTIONAL MATCH (node)-[outgoing]-(out:CI)
         WHERE out.organization_id = $organizationId
         OPTIONAL MATCH (node)<-[incoming]-(inc:CI)
         WHERE inc.organization_id = $organizationId
         RETURN node.id as id,
                node.name as name,
                node.ci_type as ci_type,
                COUNT(DISTINCT incoming) as dependents_count,
                COUNT(DISTINCT outgoing) as dependencies_count`,
        { rootCiId, organizationId, nodeLimit: neo4j.int(MAX_IMPACT_GRAPH_NODES + 1) },
        { timeout: IMPACT_QUERY_TIMEOUT_MS }
      );

      if (result.records.length > MAX_IMPACT_GRAPH_NODES) throw new ImpactCriticalityLimitError();
      work.remaining -= result.records.length;
      if (work.remaining < 0) throw new ImpactCriticalityLimitError();
      const uniqueRecords: typeof result.records = [];
      for (const record of result.records) {
        const id = record.get('id');
        if (nodeIds.has(id)) continue;
        nodeIds.add(id);
        uniqueRecords.push(record);
      }
      // Get edges
      const edgeResult = await session.run(
        `MATCH path = (root:CI {id: $rootCiId})-[*0..${maxDepth}]-(related:CI)
         WHERE ALL(n IN nodes(path) WHERE n.organization_id = $organizationId)
         UNWIND relationships(path) as rel
         WITH DISTINCT rel, startNode(rel) as source, endNode(rel) as target
         LIMIT $edgeLimit
         RETURN source.id as source_id,
                target.id as target_id,
                type(rel) as rel_type`,
        { rootCiId, organizationId, edgeLimit: neo4j.int(MAX_IMPACT_GRAPH_EDGES + 1) },
        { timeout: IMPACT_QUERY_TIMEOUT_MS }
      );
      if (edgeResult.records.length > MAX_IMPACT_GRAPH_EDGES) throw new ImpactCriticalityLimitError();
      work.remaining -= edgeResult.records.length;
      if (work.remaining < 0) throw new ImpactCriticalityLimitError();

      // Both graph streams are bounded before scoring any node or writing SQL.
      // Reuse acyclic results, but recompute each root after a back-edge because
      // cycle-dependent descendant scores cannot be shared between roots.
      for (const record of uniqueRecords) {
        const nodeId = record.get('id');
        const walk: CriticalityWalk = {
          active: new Set<string>(),
          computed: cacheable ? reusableScores : new Map<string, CriticalityScore>(),
          remaining: MAX_CRITICALITY_NODES,
          cycleDetected: false,
          sharedWork: work,
        };
        const score = await this.walkCriticality(nodeId, organizationId, walk, 0);
        if (walk.cycleDetected) {
          cacheable = false;
          pendingScores.clear();
        } else if (cacheable) {
          for (const computed of walk.computed.values()) pendingScores.set(computed.ci_id, computed);
        }
        nodes.push({
          id: nodeId,
          ci_id: nodeId,
          ci_name: record.get('name'),
          ci_type: record.get('ci_type'),
          criticality: score.criticality_score,
          dependencies_count: record.get('dependencies_count').toNumber(),
          dependents_count: record.get('dependents_count').toNumber(),
        });
      }

      for (const record of edgeResult.records) {
        const sourceId = record.get('source_id');
        const targetId = record.get('target_id');

        if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
          edges.push({
            source_id: sourceId,
            target_id: targetId,
            relationship_type: record.get('rel_type'),
            weight: 1.0,
            is_critical: record.get('rel_type') === 'DEPENDS_ON',
          });
        }
      }
      if (cacheable) {
        // Reserve all pending writes before the first one; an exhausted
        // request budget cannot leave only part of the graph's cache behind.
        if (pendingScores.size > work.remaining) throw new ImpactCriticalityLimitError();
        work.remaining -= pendingScores.size;
        for (const score of pendingScores.values()) await this.storeCriticalityScore(score, organizationId);
      }

      return {
        nodes,
        edges,
        metadata: {
          total_nodes: nodes.length,
          total_edges: edges.length,
          max_depth: maxDepth,
          generated_at: new Date(),
        },
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate impact score
   */
  private calculateImpactScore(
    blastRadius: number,
    criticality: number,
    changeType: ChangeType
  ): number {
    const changeTypeWeight = this.getChangeTypeWeight(changeType);
    return (blastRadius * 2 + criticality) * changeTypeWeight * 0.5;
  }

  /**
   * Get change type weight (higher for riskier changes)
   */
  private getChangeTypeWeight(changeType: ChangeType): number {
    switch (changeType) {
      case ChangeType.DECOMMISSION:
        return 2.0;
      case ChangeType.VERSION_UPGRADE:
        return 1.5;
      case ChangeType.NETWORK_CHANGE:
      case ChangeType.SECURITY_CHANGE:
        return 1.3;
      case ChangeType.RESTART:
        return 1.0;
      case ChangeType.CONFIGURATION_CHANGE:
      case ChangeType.PERFORMANCE_TUNING:
        return 0.8;
      default:
        return 1.0;
    }
  }

  /**
   * Calculate impact probability based on hop count
   */
  private calculateImpactProbability(hopCount: number): number {
    // Exponential decay: direct deps = 90%, 2 hops = 70%, 3 hops = 50%, etc.
    return Math.max(90 * Math.pow(0.7, hopCount - 1), 10);
  }

  /**
   * Estimate impact description
   */
  private estimateImpactDescription(hopCount: number): string {
    if (hopCount === 1) return 'Direct dependency - immediate impact expected';
    if (hopCount === 2) return 'Indirect impact through 1 intermediary';
    return `Indirect impact through ${hopCount - 1} intermediaries`;
  }

  /**
   * Determine risk level
   */
  private determineRiskLevel(impactScore: number, blastRadius: number): RiskLevel {
    if (impactScore > 80 || blastRadius > 50) return RiskLevel.CRITICAL;
    if (impactScore > 60 || blastRadius > 20) return RiskLevel.HIGH;
    if (impactScore > 40 || blastRadius > 10) return RiskLevel.MEDIUM;
    if (impactScore > 20 || blastRadius > 5) return RiskLevel.LOW;
    return RiskLevel.MINIMAL;
  }

  /**
   * Estimate downtime in minutes
   */
  private estimateDowntime(changeType: ChangeType, blastRadius: number): number | undefined {
    switch (changeType) {
      case ChangeType.RESTART:
        return 5 + blastRadius * 2;
      case ChangeType.VERSION_UPGRADE:
        return 30 + blastRadius * 5;
      case ChangeType.DECOMMISSION:
        return blastRadius * 10;
      default:
        return undefined;
    }
  }

  /**
   * Store impact analysis
   */
  private async storeImpactAnalysis(impact: ImpactAnalysis, organizationId: string): Promise<void> {
    if (!await this.neo4jClient.getCI(impact.source_ci_id, organizationId, IMPACT_QUERY_TIMEOUT_MS)) throw new Error('CI not found');
    const inserted = await this.postgresClient.query(
      `INSERT INTO impact_analyses
       (id, source_ci_id, source_ci_name, change_type, impact_score,
        blast_radius, critical_path, risk_level, analyzed_at,
        estimated_downtime_minutes, affected_cis)
       VALUES ($1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::integer,
         $6::integer, $7::jsonb, $8::varchar, $9::timestamptz, $10::integer, $11::jsonb)
       RETURNING id`,
      [
        impact.id,
        impact.source_ci_id,
        impact.source_ci_name,
        impact.change_type,
        impact.impact_score,
        impact.blast_radius,
        JSON.stringify(impact.critical_path),
        impact.risk_level,
        impact.analyzed_at,
        impact.estimated_downtime_minutes,
        JSON.stringify(impact.affected_cis),
      ]
    );
    if (inserted.rows.length === 0) throw new Error('CI not found');
  }

  /**
   * Store criticality score
   */
  private async storeCriticalityScore(score: CriticalityScore, organizationId: string): Promise<void> {
    if (!await this.neo4jClient.getCI(score.ci_id, organizationId, IMPACT_QUERY_TIMEOUT_MS)) throw new Error('CI not found');
    const inserted = await this.postgresClient.query(
      `INSERT INTO ci_criticality_scores
       (ci_id, ci_name, criticality_score, factors, calculated_at)
       VALUES ($1::varchar, $2::varchar, $3::integer, $4::jsonb, $5::timestamptz)
       ON CONFLICT (ci_id) DO UPDATE SET
         criticality_score = $3,
         factors = $4,
         calculated_at = $5 RETURNING ci_id`,
      [
        score.ci_id,
        score.ci_name,
        score.criticality_score,
        JSON.stringify(score.factors),
        score.calculated_at,
      ]
    );
    if (inserted.rows.length === 0) throw new Error('CI not found');
  }

  /**
   * Map row to criticality score
   */
  private mapRowToCriticalityScore(row: any): CriticalityScore {
    return {
      ci_id: row.ci_id,
      ci_name: row.ci_name,
      criticality_score: row.criticality_score,
      factors: row.factors,
      calculated_at: row.calculated_at,
    };
  }

  /**
   * Get impact analysis history for a CI
   */
  async getImpactHistory(ciId: string, limit: number, organizationId: string): Promise<ImpactAnalysis[]> {
    if (!await this.neo4jClient.getCI(ciId, organizationId, IMPACT_QUERY_TIMEOUT_MS)) return [];
    const result = await this.postgresClient.query(
      `SELECT h.* FROM impact_analyses h
       WHERE h.source_ci_id = $1 ORDER BY h.analyzed_at DESC LIMIT $2`,
      [ciId, limit]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      source_ci_id: row.source_ci_id,
      source_ci_name: row.source_ci_name,
      change_type: row.change_type,
      impact_score: row.impact_score,
      affected_cis: row.affected_cis,
      blast_radius: row.blast_radius,
      critical_path: row.critical_path,
      risk_level: row.risk_level,
      analyzed_at: row.analyzed_at,
      estimated_downtime_minutes: row.estimated_downtime_minutes,
    }));
  }
}

export function getImpactPredictionEngine(): ImpactPredictionEngine {
  return ImpactPredictionEngine.getInstance();
}
