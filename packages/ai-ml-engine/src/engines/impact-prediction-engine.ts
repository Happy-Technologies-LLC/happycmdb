// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Prediction Engine
 * Dependency graph analysis for change impact assessment
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';
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
import { architectureDeadlineAt, architectureRemainingMs } from './architecture-optimization-engine';
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

interface DependentNode {
  id: string;
  name: string;
  type: string;
  path: string[];
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

  /** Use the route's one deadline for SQL as well as Neo4j; plain engine calls retain pool queries. */
  private async queryWithDeadline(text: string, values: unknown[]) {
    if (architectureDeadlineAt() === undefined) return this.postgresClient.query(text, values);
    architectureRemainingMs();
    const client = await this.postgresClient.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${architectureRemainingMs()}ms`]);
      const result = await client.query(text, values);
      architectureRemainingMs();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original failure wins */ }
      throw error;
    } finally {
      client.release();
    }
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
        { timeout: architectureRemainingMs() }
      );

      if (ciResult.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const sourceCi = ciResult.records[0];
      if (!sourceCi) {
        throw new Error(`CI record not found: ${ciId}`);
      }

      // A single node budget covers both dependency traversals and criticality.
      const traversalWork = { remaining: MAX_CRITICALITY_NODES };
      const affectedCIs = await this.findAffectedCIs(ciId, organizationId, traversalWork);

      // Finish bounded graph work before any criticality cache write.
      const criticalPath = await this.findCriticalPath(ciId, organizationId, traversalWork);
      const criticalityScore = await this.getCriticalityScore(ciId, organizationId, traversalWork);
      const impactScore = this.calculateImpactScore(
        affectedCIs.length,
        criticalityScore.criticality_score,
        changeType
      );

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
  private async traverseDependents(
    sourceCIId: string, organizationId: string, maxDepth: number, types: string[],
    work: { remaining: number }
  ): Promise<DependentNode[]> {
    const session = this.neo4jClient.getSession();
    const seen = new Map<string, string[]>([[sourceCIId, [sourceCIId]]]);
    const discovered: DependentNode[] = [];
    let frontier = [sourceCIId];
    try {
      for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        // DISTINCT nodes and LIMIT apply during expansion, before recovering
        // a parent; parallel relationships cannot multiply the frontier.
        const result = await session.run(
          `UNWIND $frontier as id
           MATCH (source:CI {id: id, organization_id: $organizationId})<-[rel]-(dependent:CI {organization_id: $organizationId})
           WHERE type(rel) IN $types
           WITH DISTINCT dependent
           LIMIT $frontierLimit
           MATCH (dependent)-[parentRel]->(parent:CI {organization_id: $organizationId})
           WHERE parent.id IN $frontier AND type(parentRel) IN $types
           WITH dependent, min(parent.id) as parent_id
           RETURN dependent.id as ci_id, dependent.name as ci_name,
                  dependent.ci_type as ci_type, parent_id`,
          { frontier, organizationId, types, frontierLimit: neo4j.int(MAX_CRITICALITY_NODES + 1) },
          { timeout: architectureRemainingMs() }
        );
        if (result.records.length > MAX_CRITICALITY_NODES) throw new ImpactCriticalityLimitError();
        work.remaining -= result.records.length;
        if (work.remaining < 0) throw new ImpactCriticalityLimitError();
        const next: string[] = [];
        for (const record of result.records) {
          const id = record.get('ci_id');
          if (seen.has(id)) continue;
          const parent = seen.get(record.get('parent_id'));
          if (!parent) throw new ImpactCriticalityLimitError();
          const path = [...parent, id];
          seen.set(id, path);
          if (seen.size > MAX_CRITICALITY_NODES) throw new ImpactCriticalityLimitError();
          discovered.push({ id, name: record.get('ci_name'), type: record.get('ci_type'), path });
          next.push(id);
        }
        frontier = next;
      }
      return discovered;
    } finally {
      await session.close();
    }
  }

  private async findAffectedCIs(
    sourceCIId: string, organizationId: string, work: { remaining: number }
  ): Promise<AffectedCI[]> {
    const discovered = await this.traverseDependents(
      sourceCIId, organizationId, 5, ['DEPENDS_ON', 'USES', 'HOSTED_ON'], work
    );
    return discovered.map(({ id, name, type, path }) => {
      const hops = path.length - 1;
      return {
        ci_id: id,
        ci_name: name,
        ci_type: type,
        impact_type: hops === 1 ? ImpactType.DIRECT : ImpactType.INDIRECT,
        dependency_path: path,
        hop_count: hops,
        impact_probability: Math.round(this.calculateImpactProbability(hops)),
        estimated_impact: this.estimateImpactDescription(hops),
      };
    });
  }

  /**
   * Longest shortest DEPENDS_ON chain reached within ten bounded BFS hops.
   * This does not enumerate longer simple paths to already visited nodes.
   */
  private async findCriticalPath(
    ciId: string, organizationId: string, work: { remaining: number }
  ): Promise<string[]> {
    const discovered = await this.traverseDependents(ciId, organizationId, 10, ['DEPENDS_ON'], work);
    return discovered[discovered.length - 1]?.path ?? [ciId];
  }

  /**
   * Get or calculate criticality score for a CI
   */
  async getCriticalityScore(
    ciId: string, organizationId: string, sharedWork?: { remaining: number }
  ): Promise<CriticalityScore> {
    const walk: CriticalityWalk = {
      active: new Set<string>(),
      computed: new Map<string, CriticalityScore>(),
      remaining: MAX_CRITICALITY_NODES,
      cycleDetected: false,
      sharedWork,
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
      const ci = await this.neo4jClient.getCI(ciId, organizationId, architectureRemainingMs());
      if (!ci) throw new Error(`CI not found: ${ciId}`);
      const incarnationId = ciIncarnationId(ci)
        ?? await this.neo4jClient.ensureCIIncarnation(ciId, organizationId, architectureRemainingMs());
      if (!incarnationId) throw new Error(`CI not found: ${ciId}`);
      const cached = await this.queryWithDeadline(
        `SELECT s.* FROM ci_criticality_scores s
         WHERE s.ci_id = $1 AND s.calculated_at >= NOW() - INTERVAL '7 days'
           AND s.ci_incarnation_id = $2 AND s.organization_id = $3`,
        [ciId, incarnationId, organizationId]
      );
      if (cached.rows.length > 0) return this.mapRowToCriticalityScore(cached.rows[0]);
      const score = await this.calculateCriticalityScore(ciId, organizationId, walk, depth, incarnationId);
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
    ciId: string, organizationId: string, walk: CriticalityWalk, depth: number, incarnationId: string
  ): Promise<CriticalityScore> {
    const session = this.neo4jClient.getSession();

    try {
      // Get dependency counts and relationship weights
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         WHERE ci.organization_id = $organizationId
         CALL {
           WITH ci
           OPTIONAL MATCH (ci)<-[incoming]-(dependent:CI)
           WHERE dependent.organization_id = $organizationId
           RETURN COUNT(DISTINCT incoming) as dependent_count
         }
         CALL {
           WITH ci
           MATCH (ci)<--(dependent:CI)
           WHERE dependent.organization_id = $organizationId
           WITH DISTINCT dependent.id as dependent_id LIMIT $dependentLimit
           RETURN COLLECT(dependent_id) as dependent_ids
         }
         CALL {
           WITH ci
           OPTIONAL MATCH (ci)-[outgoing]->(dependency:CI)
           WHERE dependency.organization_id = $organizationId
           RETURN COUNT(DISTINCT outgoing) as dependency_count
         }
         RETURN ci.id as ci_id,
                ci.name as ci_name,
                dependent_count,
                dependency_count,
                dependent_ids`,
        { ciId, organizationId, dependentLimit: neo4j.int(MAX_CRITICALITY_NODES + 1) },
        { timeout: architectureRemainingMs() }
      );

      if (result.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const record = result.records[0];
      if (!record) {
        throw new Error(`Failed to get dependency data for CI: ${ciId}`);
      }
      const dependentCount = record.get('dependent_count').toNumber();
      // The producer stops at 101 distinct IDs: a full page proves this
      // walk cannot fit the 100-node budget, before further SQL or cache work.
      const dependentIds: string[] = record.get('dependent_ids');
      if (dependentIds.length > MAX_CRITICALITY_NODES) throw new ImpactCriticalityLimitError();

      // Get change frequency
      const changeFreq = await this.getChangeFrequency(ciId, incarnationId);

      // Calculate dependent weight (sum of dependent criticalities)
      let dependentWeight = 0;

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
  private async getChangeFrequency(ciId: string, incarnationId: string): Promise<number> {
    const result = await this.queryWithDeadline(
      `SELECT COUNT(*) as change_count FROM ci_change_history h
       WHERE h.ci_id = $1 AND h.changed_at >= NOW() - INTERVAL '30 days'
         AND h.ci_incarnation_id = $2`,
      [ciId, incarnationId]
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
      // Expand one hop at a time. LIMIT after a variable-length MATCH still
      // enumerates exponentially many paths before returning its first row.
      nodeIds.add(rootCiId);
      const graphEdges = new Map<string, { sourceId: string; targetId: string; type: string }>();
      let frontier = [rootCiId];
      for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];
        const adjacent = await session.run(
          `UNWIND $frontier as ciId
           MATCH (node:CI {id: ciId, organization_id: $organizationId})-[rel]-(neighbor:CI {organization_id: $organizationId})
           WITH DISTINCT rel, neighbor
           LIMIT $edgeLimit
           RETURN elementId(rel) as rel_id,
                  startNode(rel).id as source_id,
                  endNode(rel).id as target_id,
                  type(rel) as rel_type,
                  neighbor.id as neighbor_id`,
          { frontier, organizationId, edgeLimit: neo4j.int(MAX_IMPACT_GRAPH_EDGES + 1) },
          { timeout: architectureRemainingMs() }
        );
        if (adjacent.records.length > MAX_IMPACT_GRAPH_EDGES) throw new ImpactCriticalityLimitError();
        work.remaining -= adjacent.records.length;
        if (work.remaining < 0) throw new ImpactCriticalityLimitError();
        for (const record of adjacent.records) {
          const id = record.get('rel_id');
          if (!graphEdges.has(id)) {
            graphEdges.set(id, {
              sourceId: record.get('source_id'),
              targetId: record.get('target_id'),
              type: record.get('rel_type'),
            });
            if (graphEdges.size > MAX_IMPACT_GRAPH_EDGES) throw new ImpactCriticalityLimitError();
          }
          const neighborId = record.get('neighbor_id');
          if (!nodeIds.has(neighborId)) {
            nodeIds.add(neighborId);
            if (nodeIds.size > MAX_IMPACT_GRAPH_NODES) throw new ImpactCriticalityLimitError();
            next.push(neighborId);
          }
        }
        frontier = next;
      }

      const result = await session.run(
        `UNWIND $nodeIds as id
         MATCH (node:CI {id: id, organization_id: $organizationId})
         WITH node
         LIMIT $nodeLimit
         CALL {
           WITH node
           OPTIONAL MATCH (node)-[outgoing]-(out:CI)
           WHERE out.organization_id = $organizationId
           RETURN COUNT(DISTINCT outgoing) as dependencies_count
         }
         CALL {
           WITH node
           OPTIONAL MATCH (node)<-[incoming]-(inc:CI)
           WHERE inc.organization_id = $organizationId
           RETURN COUNT(DISTINCT incoming) as dependents_count
         }
         RETURN node.id as id,
                node.name as name,
                node.ci_type as ci_type,
                dependents_count,
                dependencies_count`,
        { nodeIds: [...nodeIds], organizationId, nodeLimit: neo4j.int(MAX_IMPACT_GRAPH_NODES + 1) },
        { timeout: architectureRemainingMs() }
      );
      if (result.records.length > MAX_IMPACT_GRAPH_NODES) throw new ImpactCriticalityLimitError();
      work.remaining -= result.records.length;
      if (work.remaining < 0) throw new ImpactCriticalityLimitError();
      const uniqueRecords: typeof result.records = [];
      const scoredIds = new Set<string>();
      for (const record of result.records) {
        const id = record.get('id');
        if (scoredIds.has(id)) continue;
        scoredIds.add(id);
        uniqueRecords.push(record);
      }

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

      for (const edge of graphEdges.values()) {
        if (scoredIds.has(edge.sourceId) && scoredIds.has(edge.targetId)) {
          edges.push({
            source_id: edge.sourceId,
            target_id: edge.targetId,
            relationship_type: edge.type,
            weight: 1.0,
            is_critical: edge.type === 'DEPENDS_ON',
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
    const incarnationId = await this.neo4jClient.ensureCIIncarnation(
      impact.source_ci_id, organizationId, architectureRemainingMs()
    );
    if (!incarnationId) throw new Error('CI not found');
    const inserted = await this.queryWithDeadline(
      `INSERT INTO impact_analyses
       (id, source_ci_id, source_ci_name, change_type, impact_score,
        blast_radius, critical_path, risk_level, analyzed_at,
        estimated_downtime_minutes, affected_cis, ci_incarnation_id, organization_id)
       VALUES ($1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::integer,
         $6::integer, $7::jsonb, $8::varchar, $9::timestamptz, $10::integer, $11::jsonb, $12::uuid, $13::uuid)
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
        incarnationId,
        organizationId,
      ]
    );
    if (inserted.rows.length === 0) throw new Error('CI not found');
  }

  /**
   * Store criticality score
   */
  private async storeCriticalityScore(score: CriticalityScore, organizationId: string): Promise<void> {
    const incarnationId = await this.neo4jClient.ensureCIIncarnation(
      score.ci_id, organizationId, architectureRemainingMs()
    );
    if (!incarnationId) throw new Error('CI not found');
    const inserted = await this.queryWithDeadline(
      `INSERT INTO ci_criticality_scores
       (ci_id, ci_name, criticality_score, factors, calculated_at, ci_incarnation_id, organization_id)
       VALUES ($1::varchar, $2::varchar, $3::integer, $4::jsonb, $5::timestamptz, $6::uuid, $7::uuid)
       ON CONFLICT (organization_id, ci_id) WHERE organization_id IS NOT NULL DO UPDATE SET
         ci_name = $2,
         criticality_score = $3,
         factors = $4,
         calculated_at = $5,
         ci_incarnation_id = $6 RETURNING ci_id`,
      [
        score.ci_id,
        score.ci_name,
        score.criticality_score,
        JSON.stringify(score.factors),
        score.calculated_at,
        incarnationId,
        organizationId,
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
    const incarnationId = ciIncarnationId(await this.neo4jClient.getCI(ciId, organizationId, architectureRemainingMs()));
    if (!incarnationId) return [];
    const result = await this.queryWithDeadline(
      `SELECT h.* FROM impact_analyses h
       WHERE h.source_ci_id = $1 AND h.ci_incarnation_id = $3 AND h.organization_id = $4
       ORDER BY h.analyzed_at DESC LIMIT $2`,
      [ciId, limit, incarnationId, organizationId]
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
