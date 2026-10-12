// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture Optimization Engine
 * Analyzes deployment patterns and suggests architectural improvements
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';
import {
  ArchitectureAnalysis,
  ArchitectureIssue,
  ArchitectureRecommendation,
  ArchitectureIssueType,
  ArchitectureSeverity,
  ArchitecturePattern,
  DependencyGraphMetrics,
  CircularDependencyChain,
  ArchitectureOptimizationConfig,
} from '../types/architecture.types';

/** Analysis bounds shared by POST roots and owned business-service mappings. */
export const MAX_ARCHITECTURE_ROOTS = 20;
export const MAX_ARCHITECTURE_DEPTH = 10;
export const MAX_ARCHITECTURE_EXPANSIONS = 1000;
export const ARCHITECTURE_QUERY_TIMEOUT_MS = 5000;

export class ArchitectureResourceLimitError extends Error {
  constructor() {
    super('Architecture analysis resource limit exceeded');
  }
}

/** Neo4j reports server transaction deadlines and memory exhaustion by code. */
export function architectureFailure(error: unknown): { status: number; message: string } | null {
  if (error instanceof ArchitectureResourceLimitError) {
    return { status: 503, message: 'Architecture analysis resource limit exceeded' };
  }
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  if (typeof code !== 'string') return null;
  if (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated')) {
    return { status: 504, message: 'Architecture analysis timed out' };
  }
  if (code.includes('OutOfMemory') || code.includes('MemoryLimit') || code.includes('ResourceExhausted')) {
    return { status: 503, message: 'Architecture analysis resource limit exceeded' };
  }
  return null;
}


export class ArchitectureOptimizationEngine {
  private static instance: ArchitectureOptimizationEngine;
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private config: ArchitectureOptimizationConfig;

  private constructor() {
    this.config = this.getDefaultConfig();
  }

  static getInstance(): ArchitectureOptimizationEngine {
    if (!ArchitectureOptimizationEngine.instance) {
      ArchitectureOptimizationEngine.instance = new ArchitectureOptimizationEngine();
    }
    return ArchitectureOptimizationEngine.instance;
  }

  private getDefaultConfig(): ArchitectureOptimizationConfig {
    return {
      enabled: true,
      max_fan_in_threshold: 10,
      max_fan_out_threshold: 15,
      max_coupling_coefficient: 0.3,
      min_redundancy_count: 2,
      max_dependency_depth: 5,
      detect_circular_dependencies: true,
      analyze_business_services: true,
    };
  }

  /**
   * Analyze architecture for a business service of one organization.
   * Resolves null when the service does not exist in that organization (an
   * other tenant's service is indistinguishable from a missing one).
   */
  async analyzeBusinessService(serviceId: string, organizationId: string): Promise<ArchitectureAnalysis | null> {
    logger.info('Starting architecture analysis for business service', { service_id: serviceId });

    // One statement rooted at the org-filtered parent: zero rows => unknown
    // (or another organization's) service; a single null-extended row => no
    // mappings. Reading the mappings in the same snapshot means a concurrent
    // delete + recreate of this (globally unique) service_id by another
    // organization cannot leak that organization's CIs into this analysis.
    const result = await this.postgresClient.query(
      `SELECT s.name, m.ci_id
       FROM dim_business_services s
       LEFT JOIN ci_business_service_mappings m ON m.service_id = s.service_id
       WHERE s.service_id = $1 AND s.organization_id = $2
       LIMIT $3`,
      [serviceId, organizationId, MAX_ARCHITECTURE_ROOTS + 1]
    );
    const rows: Array<{ name: string; ci_id: string | null }> = result.rows;

    if (rows.length === 0) {
      return null;
    }
    if (rows.length > MAX_ARCHITECTURE_ROOTS) {
      throw new ArchitectureResourceLimitError();
    }

    const serviceName = rows[0]!.name;
    const mappedIds = rows.flatMap((r) => (r.ci_id === null ? [] : [r.ci_id]));
    // A stale mapping can point at a foreign or NULL-owned CI. Select owned
    // roots in the graph before computing summary counts or traversing edges.
    let ciIds: string[] = [];
    if (mappedIds.length > 0) {
      const session = this.neo4jClient.getSession();
      try {
        const owned = await session.run(
          `MATCH (ci:CI)
           WHERE ci.id IN $mappedIds AND ci.organization_id = $organizationId
           RETURN DISTINCT ci.id AS id`,
          { mappedIds, organizationId },
          { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
        );
        ciIds = owned.records.map((record) => record.get('id') as string);
      } finally {
        await session.close();
      }
    }

    if (ciIds.length === 0) {
      logger.warn('No owned CIs mapped to business service', { service_id: serviceId });
      return this.createEmptyAnalysis(serviceId, serviceName);
    }

    return this.analyzeArchitecture(ciIds, organizationId, serviceId, serviceName);
  }

  /**
   * Analyze architecture for a set of CIs
   */
  async analyzeArchitecture(
    ciIds: string[],
    organizationId: string,
    businessServiceId?: string,
    businessServiceName?: string
  ): Promise<ArchitectureAnalysis> {
    if (ciIds.length > MAX_ARCHITECTURE_ROOTS) {
      throw new ArchitectureResourceLimitError();
    }
    const issues: ArchitectureIssue[] = [];
    const recommendations: ArchitectureRecommendation[] = [];

    // Reject the whole analysis rather than returning partial metrics.
    const traversal = await this.walkDependencies(ciIds, organizationId);
    const graphMetrics = await this.calculateDependencyGraphMetrics(ciIds, organizationId, traversal.depths);
    const circularDeps = this.config.detect_circular_dependencies ? traversal.cycles : [];
    if (circularDeps.length > 0) {
      issues.push(...this.createCircularDependencyIssues(circularDeps));
    }

    // 3. Detect bottlenecks (high fan-in)
    const bottlenecks = graphMetrics.filter((m) => m.fan_in > this.config.max_fan_in_threshold);
    if (bottlenecks.length > 0) {
      issues.push(...this.createBottleneckIssues(bottlenecks));
    }

    // 4. Detect tight coupling (high fan-out)
    const tightlyCoupled = graphMetrics.filter(
      (m) => m.fan_out > this.config.max_fan_out_threshold
    );
    if (tightlyCoupled.length > 0) {
      issues.push(...this.createTightCouplingIssues(tightlyCoupled));
    }

    // 5. Detect single points of failure
    const spofIssues = await this.detectSinglePointsOfFailure(graphMetrics, organizationId);
    if (spofIssues.length > 0) {
      issues.push(...spofIssues);
    }

    // 6. Detect shared database anti-pattern
    const sharedDbIssues = await this.detectSharedDatabasePattern(ciIds, organizationId);
    if (sharedDbIssues.length > 0) {
      issues.push(...sharedDbIssues);
    }

    // 7. Detect poor separation of concerns
    const separationIssues = await this.detectPoorSeparation(ciIds, organizationId);
    if (separationIssues.length > 0) {
      issues.push(...separationIssues);
    }

    // 8. Calculate health metrics
    const healthMetrics = this.calculateHealthMetrics(graphMetrics, issues);

    // 9. Determine architecture pattern
    const architecturePattern = this.determineArchitecturePattern(graphMetrics, ciIds.length);

    // 10. Generate recommendations based on issues
    for (const issue of issues) {
      recommendations.push(...issue.recommendations);
    }

    // 11. Add proactive recommendations
    const proactiveRecommendations = this.generateProactiveRecommendations(
      architecturePattern,
      healthMetrics,
      graphMetrics
    );
    recommendations.push(...proactiveRecommendations);

    // Calculate dependency graph summary
    const maxDepth = Math.max(...graphMetrics.map((m) => m.depth), 0);
    const dependencyGraphSummary = {
      total_cis: ciIds.length,
      total_dependencies: graphMetrics.reduce((sum, m) => sum + m.fan_out, 0),
      max_depth: maxDepth,
      circular_dependencies: circularDeps.length,
      bottleneck_count: bottlenecks.length,
    };

    // Calculate overall score (0-100)
    const overallScore = this.calculateOverallScore(healthMetrics);

    const analysis: ArchitectureAnalysis = {
      id: uuidv4(),
      business_service_id: businessServiceId,
      business_service_name: businessServiceName,
      analyzed_at: new Date(),
      overall_score: overallScore,
      architecture_pattern: architecturePattern,
      health_metrics: healthMetrics,
      issues,
      recommendations: this.prioritizeRecommendations(recommendations),
      dependency_graph_summary: dependencyGraphSummary,
    };

    // Store analysis
    await this.storeAnalysis(analysis);

    logger.info('Architecture analysis completed', {
      service_id: businessServiceId,
      overall_score: overallScore,
      issues_count: issues.length,
      recommendations_count: recommendations.length,
    });

    return analysis;
  }

  /**
   * Calculate dependency graph metrics for CIs
   */
  private async calculateDependencyGraphMetrics(
    ciIds: string[],
    organizationId: string,
    depths: Map<string, number>
  ): Promise<DependencyGraphMetrics[]> {
    const session = this.neo4jClient.getSession();
    const metrics: DependencyGraphMetrics[] = [];

    try {
      for (const ciId of ciIds) {
        // Calculate fan-in (CIs depending on this CI)
        const fanInResult = await session.run(
          `MATCH (ci:CI {id: $ciId})<-[r:DEPENDS_ON|USES|HOSTED_ON]-(dependent:CI)
           WHERE ci.organization_id = $organizationId
             AND dependent.organization_id = $organizationId
           RETURN COUNT(DISTINCT dependent) as fan_in`,
          { ciId, organizationId },
          { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
        );
        const fanIn = fanInResult.records[0]?.get('fan_in').toNumber() || 0;

        // Calculate fan-out (CIs this CI depends on)
        const fanOutResult = await session.run(
          `MATCH (ci:CI {id: $ciId})-[r:DEPENDS_ON|USES|HOSTED_ON]->(dependency:CI)
           WHERE ci.organization_id = $organizationId
             AND dependency.organization_id = $organizationId
           RETURN COUNT(DISTINCT dependency) as fan_out`,
          { ciId, organizationId },
          { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
        );
        const fanOut = fanOutResult.records[0]?.get('fan_out').toNumber() || 0;


        // Get CI details
        const ciResult = await session.run(
          `MATCH (ci:CI {id: $ciId})
           WHERE ci.organization_id = $organizationId
           RETURN ci.name as name, ci.ci_type as ci_type`,
          { ciId, organizationId },
          { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
        );

        const ciRecord = ciResult.records[0];
        const couplingCoefficient = (fanIn + fanOut) / ciIds.length;

        metrics.push({
          ci_id: ciId,
          ci_name: ciRecord?.get('name') || ciId,
          ci_type: ciRecord?.get('ci_type') || 'unknown',
          fan_in: fanIn,
          fan_out: fanOut,
          depth: depths.get(ciId) ?? 0,
          in_critical_path: fanIn > 5 || fanOut > 5,
          is_bottleneck: fanIn > this.config.max_fan_in_threshold,
          coupling_coefficient: couplingCoefficient,
        });
      }
    } finally {
      await session.close();
    }

    return metrics;
  }

  /**
   * Breadth-first, one-hop expansion: LIMIT applies to one frontier, never
   * after a variable-length path enumeration. Every returned row spends the
   * shared budget, including leaves; exceeding it fails without partial data.
   */
  private async walkDependencies(
    ciIds: string[],
    organizationId: string
  ): Promise<{ depths: Map<string, number>; cycles: CircularDependencyChain[] }> {
    const session = this.neo4jClient.getSession();
    const depths = new Map<string, number>();
    const cycles: CircularDependencyChain[] = [];
    const seenCycles = new Set<string>();
    let remaining = MAX_ARCHITECTURE_EXPANSIONS;
    try {
      for (const root of ciIds) {
        let frontier: string[][] = [[root]];
        let depth = 0;
        for (let hop = 0; hop < MAX_ARCHITECTURE_DEPTH && frontier.length > 0; hop++) {
          const result = await session.run(
            `UNWIND $frontier AS path
             MATCH (ci:CI {id: path[size(path)-1]})
             WHERE ci.organization_id = $organizationId
             OPTIONAL MATCH (ci)-[:DEPENDS_ON|USES]->(next:CI)
             WHERE next.organization_id = $organizationId
             RETURN path, next.id AS nextId
             LIMIT toInteger($limit)`,
            { frontier, organizationId, limit: remaining + 1 },
            { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
          );
          if (result.records.length > remaining) throw new ArchitectureResourceLimitError();
          remaining -= result.records.length;
          const nextFrontier: string[][] = [];
          for (const record of result.records) {
            const path = record.get('path') as string[];
            const nextId = record.get('nextId') as string | null;
            if (nextId === null) {
              depth = Math.max(depth, path.length - 1);
            } else if (nextId === root && path.length >= 2) {
              const cycle = [...path, root];
              const key = JSON.stringify(cycle);
              if (!seenCycles.has(key)) {
                seenCycles.add(key);
                cycles.push({
                  cis: cycle,
                  chain_length: cycle.length,
                  severity: cycle.length <= 3 ? ArchitectureSeverity.CRITICAL
                    : cycle.length <= 5 ? ArchitectureSeverity.HIGH : ArchitectureSeverity.MEDIUM,
                });
              }
            } else if (!path.includes(nextId)) {
              nextFrontier.push([...path, nextId]);
            }
          }
          frontier = nextFrontier;
        }
        if (frontier.length > 0) depth = Math.max(depth, MAX_ARCHITECTURE_DEPTH);
        depths.set(root, depth);
      }
      return { depths, cycles };
    } finally {
      await session.close();
    }
  }

  /**
   * Create issues for circular dependencies
   */
  private createCircularDependencyIssues(
    chains: CircularDependencyChain[]
  ): ArchitectureIssue[] {
    return chains.map((chain) => ({
      id: uuidv4(),
      issue_type: ArchitectureIssueType.CIRCULAR_DEPENDENCY,
      severity: chain.severity,
      title: `Circular dependency detected (${chain.chain_length} CIs)`,
      description: `Circular dependency chain: ${chain.cis.join(' → ')} → ${chain.cis[0]}. This creates tight coupling and makes the system fragile.`,
      affected_cis: chain.cis,
      confidence_score: 100,
      detected_at: new Date(),
      metrics: {
        chain_length: chain.chain_length,
      },
      recommendations: [
        {
          id: uuidv4(),
          priority: chain.severity === ArchitectureSeverity.CRITICAL ? 'p0' : 'p1',
          category: 'refactoring',
          title: 'Break circular dependency',
          description: 'Refactor to remove circular dependency by introducing dependency inversion or event-driven communication.',
          rationale:
            'Circular dependencies create tight coupling, making changes risky and deployments complex. Breaking the cycle improves maintainability and testability.',
          implementation_steps: [
            'Identify the weakest link in the dependency chain',
            'Introduce an abstraction layer or interface',
            'Use dependency injection or event-driven patterns',
            'Implement async messaging where appropriate',
            'Test each component independently',
          ],
          estimated_effort: '3-5 days',
          expected_benefit: 'Improved modularity, easier testing, safer deployments',
          risk_if_ignored: 'Cascading failures, difficult debugging, deployment deadlocks',
          architectural_pattern: ArchitecturePattern.EVENT_DRIVEN,
          references: [
            'https://martinfowler.com/articles/break-circular-dependencies.html',
          ],
        },
      ],
    }));
  }

  /**
   * Create issues for bottlenecks
   */
  private createBottleneckIssues(bottlenecks: DependencyGraphMetrics[]): ArchitectureIssue[] {
    return bottlenecks.map((bottleneck) => ({
      id: uuidv4(),
      issue_type: ArchitectureIssueType.BOTTLENECK,
      severity:
        bottleneck.fan_in > 20
          ? ArchitectureSeverity.CRITICAL
          : bottleneck.fan_in > 15
          ? ArchitectureSeverity.HIGH
          : ArchitectureSeverity.MEDIUM,
      title: `Bottleneck detected: ${bottleneck.ci_name}`,
      description: `${bottleneck.ci_name} has ${bottleneck.fan_in} dependent CIs, creating a single point of contention. Changes to this CI affect many downstream systems.`,
      affected_cis: [bottleneck.ci_id],
      confidence_score: 95,
      detected_at: new Date(),
      metrics: {
        fan_in: bottleneck.fan_in,
        coupling_coefficient: bottleneck.coupling_coefficient,
      },
      recommendations: [
        {
          id: uuidv4(),
          priority: bottleneck.fan_in > 20 ? 'p0' : 'p1',
          category: 'design',
          title: 'Reduce fan-in by decomposing functionality',
          description: `Split ${bottleneck.ci_name} into smaller, focused services to reduce coupling.`,
          rationale:
            'High fan-in indicates this CI is doing too much or is a shared dependency. Decomposing reduces blast radius of changes.',
          implementation_steps: [
            'Identify distinct responsibilities within the CI',
            'Extract separate services for each responsibility',
            'Use API gateway or service mesh for routing',
            'Implement caching layer if appropriate',
            'Consider read replicas for databases',
          ],
          estimated_effort: '2-4 weeks',
          expected_benefit: 'Reduced coupling, improved scalability, smaller blast radius',
          risk_if_ignored:
            'Single point of failure, performance bottleneck, difficult to scale',
          architectural_pattern: ArchitecturePattern.MICROSERVICES,
        },
      ],
    }));
  }

  /**
   * Create issues for tight coupling
   */
  private createTightCouplingIssues(
    tightlyCoupled: DependencyGraphMetrics[]
  ): ArchitectureIssue[] {
    return tightlyCoupled.map((ci) => ({
      id: uuidv4(),
      issue_type: ArchitectureIssueType.TIGHT_COUPLING,
      severity:
        ci.fan_out > 25
          ? ArchitectureSeverity.HIGH
          : ci.fan_out > 20
          ? ArchitectureSeverity.MEDIUM
          : ArchitectureSeverity.LOW,
      title: `Tight coupling detected: ${ci.ci_name}`,
      description: `${ci.ci_name} depends on ${ci.fan_out} other CIs, indicating tight coupling. This makes changes difficult and increases fragility.`,
      affected_cis: [ci.ci_id],
      confidence_score: 90,
      detected_at: new Date(),
      metrics: {
        fan_out: ci.fan_out,
        coupling_coefficient: ci.coupling_coefficient,
      },
      recommendations: [
        {
          id: uuidv4(),
          priority: 'p2',
          category: 'refactoring',
          title: 'Reduce dependencies through abstraction',
          description: `Refactor ${ci.ci_name} to depend on abstractions instead of concrete implementations.`,
          rationale:
            'High fan-out makes the CI fragile. Any change to dependencies can break this CI.',
          implementation_steps: [
            'Identify essential vs. non-essential dependencies',
            'Introduce facade or adapter patterns',
            'Use dependency injection',
            'Consider async event-driven patterns',
            'Consolidate related dependencies behind interfaces',
          ],
          estimated_effort: '1-2 weeks',
          expected_benefit: 'Improved testability, reduced fragility, easier maintenance',
          risk_if_ignored: 'Brittle system, difficult testing, slow development velocity',
          architectural_pattern: ArchitecturePattern.LAYERED,
        },
      ],
    }));
  }

  /**
   * Detect single points of failure
   */
  private async detectSinglePointsOfFailure(
    metrics: DependencyGraphMetrics[],
    organizationId: string
  ): Promise<ArchitectureIssue[]> {
    const issues: ArchitectureIssue[] = [];
    const session = this.neo4jClient.getSession();

    try {
      for (const metric of metrics) {
        if (metric.fan_in < 3) continue; // Not critical enough

        // Check if CI has redundancy (similar CIs in same environment)
        const redundancyResult = await session.run(
          `MATCH (ci:CI {id: $ciId})
           MATCH (similar:CI)
           WHERE ci.organization_id = $organizationId
             AND similar.organization_id = $organizationId
             AND similar.ci_type = ci.ci_type
             AND similar.environment = ci.environment
             AND similar.id <> ci.id
             AND similar.status = 'active'
           RETURN COUNT(similar) as redundancy_count`,
          { ciId: metric.ci_id, organizationId },
          { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
        );

        const redundancyCount = redundancyResult.records[0]?.get('redundancy_count').toNumber() || 0;

        if (redundancyCount < this.config.min_redundancy_count && metric.fan_in >= 5) {
          issues.push({
            id: uuidv4(),
            issue_type: ArchitectureIssueType.SINGLE_POINT_OF_FAILURE,
            severity:
              metric.fan_in > 15
                ? ArchitectureSeverity.CRITICAL
                : ArchitectureSeverity.HIGH,
            title: `Single point of failure: ${metric.ci_name}`,
            description: `${metric.ci_name} has ${metric.fan_in} dependents but lacks redundancy. Failure would affect multiple services.`,
            affected_cis: [metric.ci_id],
            confidence_score: 85,
            detected_at: new Date(),
            metrics: {
              fan_in: metric.fan_in,
              redundancy_count: redundancyCount,
            },
            recommendations: [
              {
                id: uuidv4(),
                priority: metric.fan_in > 15 ? 'p0' : 'p1',
                category: 'infrastructure',
                title: 'Add redundancy and high availability',
                description: `Deploy additional instances of ${metric.ci_name} for redundancy.`,
                rationale:
                  'Single points of failure create availability risk. Redundancy ensures service continuity.',
                implementation_steps: [
                  'Deploy at least 2 additional instances',
                  'Implement load balancing',
                  'Configure health checks and auto-scaling',
                  'Set up cross-region replication if critical',
                  'Test failover scenarios',
                ],
                estimated_effort: '1-2 weeks',
                expected_benefit: 'Improved availability, fault tolerance, zero-downtime deployments',
                risk_if_ignored: 'Service outages, revenue loss, poor user experience',
              },
            ],
          });
        }
      }
    } finally {
      await session.close();
    }

    return issues;
  }

  /**
   * Detect shared database anti-pattern
   */
  private async detectSharedDatabasePattern(ciIds: string[], organizationId: string): Promise<ArchitectureIssue[]> {
    const issues: ArchitectureIssue[] = [];
    const session = this.neo4jClient.getSession();

    try {
      // Find databases with multiple applications depending on them
      const result = await session.run(
        `MATCH (db:CI)
         WHERE db.ci_type IN ['database', 'postgresql', 'mysql', 'mongodb', 'redis']
           AND db.id IN $ciIds
           AND db.organization_id = $organizationId
         MATCH (app:CI)-[:USES|DEPENDS_ON]->(db)
         WHERE app.ci_type IN ['application', 'service', 'api', 'web-app']
           AND app.organization_id = $organizationId
         WITH db, COLLECT(DISTINCT app.id) as apps
         WHERE SIZE(apps) > 2
         RETURN db.id as db_id, db.name as db_name, apps, SIZE(apps) as app_count`,
        { ciIds, organizationId },
        { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
      );

      for (const record of result.records) {
        const dbId = record.get('db_id');
        const dbName = record.get('db_name');
        const apps = record.get('apps');
        const appCount = record.get('app_count').toNumber();

        issues.push({
          id: uuidv4(),
          issue_type: ArchitectureIssueType.SHARED_DATABASE,
          severity:
            appCount > 5
              ? ArchitectureSeverity.HIGH
              : ArchitectureSeverity.MEDIUM,
          title: `Shared database anti-pattern: ${dbName}`,
          description: `${dbName} is shared by ${appCount} applications. This creates tight coupling and makes independent deployment difficult.`,
          affected_cis: [dbId, ...apps],
          confidence_score: 90,
          detected_at: new Date(),
          metrics: {
            shared_by_count: appCount,
          },
          recommendations: [
            {
              id: uuidv4(),
              priority: 'p2',
              category: 'design',
              title: 'Implement database-per-service pattern',
              description: 'Give each service its own database to reduce coupling.',
              rationale:
                'Shared databases create hidden dependencies and make it impossible to deploy services independently.',
              implementation_steps: [
                'Identify clear service boundaries',
                'Create separate database instances per service',
                'Use API calls instead of direct database access',
                'Implement event-driven data synchronization if needed',
                'Migrate data incrementally with dual-write pattern',
              ],
              estimated_effort: '4-8 weeks',
              expected_benefit: 'Independent deployments, better scalability, clear ownership',
              risk_if_ignored: 'Tight coupling, deployment conflicts, data integrity issues',
              architectural_pattern: ArchitecturePattern.MICROSERVICES,
              references: [
                'https://microservices.io/patterns/data/database-per-service.html',
              ],
            },
          ],
        });
      }
    } finally {
      await session.close();
    }

    return issues;
  }

  /**
   * Detect poor separation of concerns
   */
  private async detectPoorSeparation(ciIds: string[], organizationId: string): Promise<ArchitectureIssue[]> {
    const issues: ArchitectureIssue[] = [];
    const session = this.neo4jClient.getSession();

    try {
      // Find CIs with mixed concerns (e.g., application directly connecting to multiple databases)
      const result = await session.run(
        `MATCH (app:CI)-[:USES|DEPENDS_ON]->(resource:CI)
         WHERE app.id IN $ciIds
           AND app.organization_id = $organizationId
           AND resource.organization_id = $organizationId
           AND app.ci_type IN ['application', 'service']
           AND resource.ci_type IN ['database', 'queue', 'cache', 'storage']
         WITH app, COLLECT(DISTINCT resource.ci_type) as resource_types
         WHERE SIZE(resource_types) > 3
         RETURN app.id as app_id, app.name as app_name, resource_types, SIZE(resource_types) as type_count`,
        { ciIds, organizationId },
        { timeout: ARCHITECTURE_QUERY_TIMEOUT_MS }
      );

      for (const record of result.records) {
        const appId = record.get('app_id');
        const appName = record.get('app_name');
        const resourceTypes = record.get('resource_types');
        const typeCount = record.get('type_count').toNumber();

        issues.push({
          id: uuidv4(),
          issue_type: ArchitectureIssueType.POOR_SEPARATION,
          severity: ArchitectureSeverity.MEDIUM,
          title: `Poor separation of concerns: ${appName}`,
          description: `${appName} directly accesses ${typeCount} different resource types (${resourceTypes.join(', ')}). Consider using a layered architecture.`,
          affected_cis: [appId],
          confidence_score: 75,
          detected_at: new Date(),
          metrics: {
            resource_type_count: typeCount,
          },
          recommendations: [
            {
              id: uuidv4(),
              priority: 'p3',
              category: 'design',
              title: 'Implement layered architecture',
              description: 'Separate data access, business logic, and presentation concerns into distinct layers.',
              rationale:
                'Mixing concerns makes the application difficult to understand, test, and maintain.',
              implementation_steps: [
                'Create data access layer (repositories/DAOs)',
                'Separate business logic into service layer',
                'Use dependency injection for layer communication',
                'Apply single responsibility principle',
                'Consider hexagonal/clean architecture patterns',
              ],
              estimated_effort: '2-3 weeks',
              expected_benefit: 'Better testability, clearer code organization, easier maintenance',
              risk_if_ignored: 'Technical debt accumulation, difficult refactoring',
              architectural_pattern: ArchitecturePattern.LAYERED,
            },
          ],
        });
      }
    } finally {
      await session.close();
    }

    return issues;
  }

  /**
   * Calculate health metrics
   */
  private calculateHealthMetrics(
    metrics: DependencyGraphMetrics[],
    issues: ArchitectureIssue[]
  ): ArchitectureAnalysis['health_metrics'] {
    const avgCoupling =
      metrics.reduce((sum, m) => sum + m.coupling_coefficient, 0) / metrics.length || 0;
    const couplingScore = Math.max(0, 100 - avgCoupling * 100);

    const bottleneckCount = issues.filter(
      (i) => i.issue_type === ArchitectureIssueType.BOTTLENECK
    ).length;
    const scalabilityScore = Math.max(0, 100 - bottleneckCount * 15);

    const spofCount = issues.filter(
      (i) => i.issue_type === ArchitectureIssueType.SINGLE_POINT_OF_FAILURE
    ).length;
    const redundancyScore = Math.max(0, 100 - spofCount * 20);

    const securityIssues = issues.filter(
      (i) => i.issue_type === ArchitectureIssueType.SECURITY_GAP
    ).length;
    const securityScore = Math.max(0, 100 - securityIssues * 25);

    const circularDepCount = issues.filter(
      (i) => i.issue_type === ArchitectureIssueType.CIRCULAR_DEPENDENCY
    ).length;
    const maintainabilityScore = Math.max(0, 100 - circularDepCount * 20 - avgCoupling * 50);

    // Cohesion is inverse of coupling
    const cohesionScore = 100 - couplingScore;

    return {
      coupling_score: Math.round(couplingScore),
      cohesion_score: Math.round(cohesionScore),
      redundancy_score: Math.round(redundancyScore),
      scalability_score: Math.round(scalabilityScore),
      security_score: Math.round(securityScore),
      maintainability_score: Math.round(maintainabilityScore),
    };
  }

  /**
   * Determine architecture pattern
   */
  private determineArchitecturePattern(
    metrics: DependencyGraphMetrics[],
    totalCIs: number
  ): ArchitecturePattern {
    const avgFanOut = metrics.reduce((sum, m) => sum + m.fan_out, 0) / metrics.length || 0;
    const avgFanIn = metrics.reduce((sum, m) => sum + m.fan_in, 0) / metrics.length || 0;

    if (totalCIs <= 5 && avgFanOut > 3) {
      return ArchitecturePattern.MONOLITH;
    }

    if (avgFanOut < 3 && avgFanIn < 3 && totalCIs > 10) {
      return ArchitecturePattern.MICROSERVICES;
    }

    if (avgFanOut > 5) {
      return ArchitecturePattern.SERVICE_ORIENTED;
    }

    return ArchitecturePattern.LAYERED;
  }

  /**
   * Generate proactive recommendations
   */
  private generateProactiveRecommendations(
    pattern: ArchitecturePattern,
    healthMetrics: ArchitectureAnalysis['health_metrics'],
    metrics: DependencyGraphMetrics[]
  ): ArchitectureRecommendation[] {
    const recommendations: ArchitectureRecommendation[] = [];

    // Recommend observability improvements
    if (healthMetrics.maintainability_score < 70) {
      recommendations.push({
        id: uuidv4(),
        priority: 'p2',
        category: 'monitoring',
        title: 'Improve observability and monitoring',
        description: 'Add distributed tracing, centralized logging, and health checks.',
        rationale:
          'Complex architectures require comprehensive observability to understand system behavior.',
        implementation_steps: [
          'Implement distributed tracing (Jaeger, Zipkin)',
          'Set up centralized logging (ELK, Splunk)',
          'Add health check endpoints to all services',
          'Implement service mesh for advanced observability',
          'Set up alerts for key metrics',
        ],
        estimated_effort: '2-3 weeks',
        expected_benefit: 'Faster debugging, better visibility, proactive issue detection',
        risk_if_ignored: 'Difficult troubleshooting, longer MTTR',
      });
    }

    // Recommend API gateway if microservices pattern
    if (pattern === ArchitecturePattern.MICROSERVICES && metrics.length > 10) {
      recommendations.push({
        id: uuidv4(),
        priority: 'p2',
        category: 'infrastructure',
        title: 'Implement API Gateway pattern',
        description: 'Use API Gateway to centralize cross-cutting concerns.',
        rationale: 'API Gateway provides unified entry point and handles auth, rate limiting, routing.',
        implementation_steps: [
          'Deploy API Gateway (Kong, AWS API Gateway, Azure APIM)',
          'Migrate authentication to gateway',
          'Implement rate limiting and throttling',
          'Add request/response transformation',
          'Set up caching at gateway level',
        ],
        estimated_effort: '3-4 weeks',
        expected_benefit: 'Simplified client integration, centralized security, better performance',
        risk_if_ignored: 'Duplicated logic across services, inconsistent security',
        architectural_pattern: ArchitecturePattern.MICROSERVICES,
      });
    }

    // Recommend caching strategy
    if (healthMetrics.scalability_score < 80) {
      recommendations.push({
        id: uuidv4(),
        priority: 'p3',
        category: 'infrastructure',
        title: 'Implement caching strategy',
        description: 'Add caching layers to improve performance and reduce load.',
        rationale: 'Caching reduces database load and improves response times.',
        implementation_steps: [
          'Identify frequently accessed data',
          'Deploy Redis or Memcached cluster',
          'Implement cache-aside pattern',
          'Set appropriate TTLs',
          'Add cache invalidation strategy',
        ],
        estimated_effort: '1-2 weeks',
        expected_benefit: 'Improved performance, reduced database load, better scalability',
        risk_if_ignored: 'Performance bottlenecks, higher infrastructure costs',
      });
    }

    return recommendations;
  }

  /**
   * Calculate overall score
   */
  private calculateOverallScore(
    healthMetrics: ArchitectureAnalysis['health_metrics']
  ): number {
    const weights = {
      coupling: 0.25,
      redundancy: 0.20,
      scalability: 0.20,
      security: 0.20,
      maintainability: 0.15,
    };

    return Math.round(
      healthMetrics.coupling_score * weights.coupling +
        healthMetrics.redundancy_score * weights.redundancy +
        healthMetrics.scalability_score * weights.scalability +
        healthMetrics.security_score * weights.security +
        healthMetrics.maintainability_score * weights.maintainability
    );
  }

  /**
   * Prioritize recommendations
   */
  private prioritizeRecommendations(
    recommendations: ArchitectureRecommendation[]
  ): ArchitectureRecommendation[] {
    const priorityOrder = { p0: 0, p1: 1, p2: 2, p3: 3 };
    return recommendations.sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    );
  }

  /**
   * Store analysis in database
   */
  private async storeAnalysis(analysis: ArchitectureAnalysis): Promise<void> {
    try {
      await this.postgresClient.query(
        `INSERT INTO architecture_analyses (
          id, business_service_id, analyzed_at, overall_score,
          architecture_pattern, health_metrics, issues, recommendations,
          dependency_graph_summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          overall_score = EXCLUDED.overall_score,
          health_metrics = EXCLUDED.health_metrics,
          issues = EXCLUDED.issues,
          recommendations = EXCLUDED.recommendations`,
        [
          analysis.id,
          analysis.business_service_id,
          analysis.analyzed_at,
          analysis.overall_score,
          analysis.architecture_pattern,
          JSON.stringify(analysis.health_metrics),
          JSON.stringify(analysis.issues),
          JSON.stringify(analysis.recommendations),
          JSON.stringify(analysis.dependency_graph_summary),
        ]
      );
    } catch (error: any) {
      // Table may not exist - log warning but don't fail
      logger.warn('Failed to store architecture analysis', { error: error.message });
    }
  }

  /**
   * Create empty analysis for service with no CIs
   */
  private createEmptyAnalysis(
    serviceId: string,
    serviceName: string
  ): ArchitectureAnalysis {
    return {
      id: uuidv4(),
      business_service_id: serviceId,
      business_service_name: serviceName,
      analyzed_at: new Date(),
      overall_score: 0,
      architecture_pattern: ArchitecturePattern.MONOLITH,
      health_metrics: {
        coupling_score: 0,
        cohesion_score: 0,
        redundancy_score: 0,
        scalability_score: 0,
        security_score: 0,
        maintainability_score: 0,
      },
      issues: [],
      recommendations: [],
      dependency_graph_summary: {
        total_cis: 0,
        total_dependencies: 0,
        max_depth: 0,
        circular_dependencies: 0,
        bottleneck_count: 0,
      },
    };
  }
}

export function getArchitectureOptimizationEngine(): ArchitectureOptimizationEngine {
  return ArchitectureOptimizationEngine.getInstance();
}
