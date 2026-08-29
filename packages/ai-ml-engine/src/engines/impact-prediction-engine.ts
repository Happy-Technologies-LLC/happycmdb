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
    changeType: ChangeType
  ): Promise<ImpactAnalysis> {
    logger.info('Predicting change impact', { ci_id: ciId, change_type: changeType });

    const session = this.neo4jClient.getSession();

    try {
      // Get source CI details
      const ciResult = await session.run(
        `MATCH (ci:CI {id: $ciId})
         RETURN ci.id as id, ci.name as name, ci.ci_type as ci_type`,
        { ciId }
      );

      if (ciResult.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const sourceCi = ciResult.records[0];
      if (!sourceCi) {
        throw new Error(`CI record not found: ${ciId}`);
      }

      // Find all affected CIs (downstream dependencies)
      const affectedCIs = await this.findAffectedCIs(ciId);

      // Calculate impact score based on criticality and blast radius
      const criticalityScore = await this.getCriticalityScore(ciId);
      const impactScore = this.calculateImpactScore(
        affectedCIs.length,
        criticalityScore.criticality_score,
        changeType
      );

      // Find critical path (longest dependency chain)
      const criticalPath = await this.findCriticalPath(ciId);

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
      await this.storeImpactAnalysis(impact);

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
  private async findAffectedCIs(sourceCIId: string): Promise<AffectedCI[]> {
    const session = this.neo4jClient.getSession();
    const affectedCIs: AffectedCI[] = [];

    try {
      // Find all downstream dependencies (CIs that depend on this CI)
      const result = await session.run(
        `MATCH path = (source:CI {id: $ciId})<-[*1..5]-(dependent:CI)
         WHERE ALL(r IN relationships(path) WHERE type(r) IN ['DEPENDS_ON', 'USES', 'HOSTED_ON'])
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
        { ciId: sourceCIId }
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
  private async findCriticalPath(ciId: string): Promise<string[]> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH path = (source:CI {id: $ciId})<-[*1..10]-(dependent:CI)
         WHERE ALL(r IN relationships(path) WHERE type(r) = 'DEPENDS_ON')
         WITH path, length(path) as path_length
         ORDER BY path_length DESC
         LIMIT 1
         RETURN [node IN nodes(path) | node.id] as critical_path`,
        { ciId }
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
  async getCriticalityScore(ciId: string): Promise<CriticalityScore> {
    // Check if cached
    const cached = await this.postgresClient.query(
      `SELECT * FROM ci_criticality_scores
       WHERE ci_id = $1
       AND calculated_at >= NOW() - INTERVAL '7 days'`,
      [ciId]
    );

    if (cached.rows.length > 0) {
      return this.mapRowToCriticalityScore(cached.rows[0]);
    }

    // Calculate new score
    return await this.calculateCriticalityScore(ciId);
  }

  /**
   * Calculate criticality score based on multiple factors
   */
  private async calculateCriticalityScore(ciId: string): Promise<CriticalityScore> {
    const session = this.neo4jClient.getSession();

    try {
      // Get dependency counts and relationship weights
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         OPTIONAL MATCH (ci)<-[incoming]-(dependent)
         OPTIONAL MATCH (ci)-[outgoing]->(dependency)
         WITH ci,
              COUNT(DISTINCT incoming) as dependent_count,
              COUNT(DISTINCT outgoing) as dependency_count,
              COLLECT(DISTINCT dependent.id) as dependent_ids
         RETURN ci.id as ci_id,
                ci.name as ci_name,
                dependent_count,
                dependency_count,
                dependent_ids`,
        { ciId }
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
        const depScore = await this.getCriticalityScore(depId);
        dependentWeight += depScore.criticality_score * 0.5; // Weighted contribution
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

      // Store score
      await this.storeCriticalityScore(score);

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
      `SELECT COUNT(*) as change_count
       FROM ci_change_history
       WHERE ci_id = $1
       AND changed_at >= NOW() - INTERVAL '30 days'`,
      [ciId]
    );

    const firstRow = result.rows[0];
    return parseInt(firstRow?.change_count || '0');
  }

  /**
   * Build dependency graph for visualization
   */
  async buildDependencyGraph(rootCiId: string, maxDepth: number = 3): Promise<DependencyGraph> {
    const session = this.neo4jClient.getSession();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();

    try {
      // Get nodes and relationships
      const result = await session.run(
        `MATCH path = (root:CI {id: $rootCiId})-[*0..${maxDepth}]-(related:CI)
         WITH nodes(path) as path_nodes, relationships(path) as path_rels
         UNWIND path_nodes as node
         WITH DISTINCT node
         OPTIONAL MATCH (node)-[outgoing]-()
         OPTIONAL MATCH (node)<-[incoming]-()
         RETURN node.id as id,
                node.name as name,
                node.ci_type as ci_type,
                COUNT(DISTINCT incoming) as dependents_count,
                COUNT(DISTINCT outgoing) as dependencies_count`,
        { rootCiId }
      );

      // Build nodes
      for (const record of result.records) {
        const nodeId = record.get('id');
        if (nodeIds.has(nodeId)) continue;

        nodeIds.add(nodeId);

        const criticalityScore = await this.getCriticalityScore(nodeId);

        nodes.push({
          id: nodeId,
          ci_id: nodeId,
          ci_name: record.get('name'),
          ci_type: record.get('ci_type'),
          criticality: criticalityScore.criticality_score,
          dependencies_count: record.get('dependencies_count').toNumber(),
          dependents_count: record.get('dependents_count').toNumber(),
        });
      }

      // Get edges
      const edgeResult = await session.run(
        `MATCH path = (root:CI {id: $rootCiId})-[*0..${maxDepth}]-(related:CI)
         WITH relationships(path) as path_rels
         UNWIND path_rels as rel
         WITH DISTINCT rel, startNode(rel) as source, endNode(rel) as target
         RETURN source.id as source_id,
                target.id as target_id,
                type(rel) as rel_type`,
        { rootCiId }
      );

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
  private async storeImpactAnalysis(impact: ImpactAnalysis): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO impact_analyses
       (id, source_ci_id, source_ci_name, change_type, impact_score,
        blast_radius, critical_path, risk_level, analyzed_at,
        estimated_downtime_minutes, affected_cis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
  }

  /**
   * Store criticality score
   */
  private async storeCriticalityScore(score: CriticalityScore): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO ci_criticality_scores
       (ci_id, ci_name, criticality_score, factors, calculated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ci_id) DO UPDATE SET
         criticality_score = $3,
         factors = $4,
         calculated_at = $5`,
      [
        score.ci_id,
        score.ci_name,
        score.criticality_score,
        JSON.stringify(score.factors),
        score.calculated_at,
      ]
    );
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
  async getImpactHistory(ciId: string, limit: number = 20): Promise<ImpactAnalysis[]> {
    const result = await this.postgresClient.query(
      `SELECT * FROM impact_analyses
       WHERE source_ci_id = $1
       ORDER BY analyzed_at DESC
       LIMIT $2`,
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
