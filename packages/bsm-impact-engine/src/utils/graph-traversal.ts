// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Graph Traversal Utility
 * Efficient Neo4j graph traversal for dependency analysis
 */

import { getNeo4jClient } from '@cmdb/database';
import { BusinessService } from '@cmdb/unified-model';
import {
  DependencyTree,
  DependencyNode,
  CriticalPath,
  BlastRadiusOptions,
  ImpactedCI,
  ImpactedBusinessService,
} from '../types/impact-types';
import { BusinessCriticality } from '../types/bsm-types';

/**
 * Graph Traversal Service
 * Provides efficient graph traversal methods for dependency and impact analysis
 */
export class GraphTraversal {
  /**
   * Find all downstream dependencies from a source CI
   * Traverses relationships like DEPENDS_ON, RUNS_ON, CONNECTS_TO
   *
   * @param ciId - Source CI identifier
   * @param maxHops - Maximum number of hops to traverse (default: 10)
   * @param options - Additional traversal options
   * @returns Dependency tree structure
   */
  async findDownstreamDependencies(
    ciId: string,
    maxHops: number = 10,
    options?: BlastRadiusOptions
  ): Promise<DependencyTree> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // Query to find all downstream dependencies
      // Uses variable-length pattern matching with depth limit
      const query = `
        MATCH path = (source:CI {id: $ciId})-[r:DEPENDS_ON|RUNS_ON|CONNECTS_TO|USES*1..${maxHops}]->(dependent:CI)
        WHERE source.id = $ciId
          ${options?.includeInactive ? '' : 'AND dependent.status = "active"'}
        WITH source, dependent, path, length(path) as depth
        RETURN source.id as sourceId,
               source.name as sourceName,
               source.type as sourceType,
               source.business_criticality as sourceCriticality,
               dependent.id as dependentId,
               dependent.name as dependentName,
               dependent.type as dependentType,
               dependent.business_criticality as dependentCriticality,
               depth,
               [rel in relationships(path) | type(rel)] as relationshipTypes
        ORDER BY depth, dependentName
        LIMIT 10000
      `;

      const result = await session.run(query, { ciId });

      // Build dependency tree
      const root: DependencyNode = {
        ciId: ciId,
        ciName: result.records[0]?.get('sourceName') || 'Unknown',
        ciType: result.records[0]?.get('sourceType') || 'unknown',
        criticality:
          (result.records[0]?.get('sourceCriticality') as BusinessCriticality) || 'tier_4',
        depth: 0,
        children: [],
      };

      const nodeMap = new Map<string, DependencyNode>();
      nodeMap.set(ciId, root);

      let maxDepth = 0;
      const criticalPaths: CriticalPath[] = [];

      // Process each dependency record
      for (const record of result.records) {
        const dependentId = record.get('dependentId');
        const depth = record.get('depth').toNumber();

        if (depth > maxDepth) {
          maxDepth = depth;
        }

        // Create or update dependent node
        if (!nodeMap.has(dependentId)) {
          const node: DependencyNode = {
            ciId: dependentId,
            ciName: record.get('dependentName'),
            ciType: record.get('dependentType'),
            criticality: record.get('dependentCriticality') || 'tier_4',
            depth: depth,
            children: [],
          };
          nodeMap.set(dependentId, node);
        }
      }

      // Build tree structure (simplified - flat list for now)
      // In production, you'd build a proper tree hierarchy
      root.children = Array.from(nodeMap.values()).filter((node) => node.ciId !== ciId);

      const dependencyTree: DependencyTree = {
        root,
        totalNodes: nodeMap.size,
        maxDepth,
        criticalPaths,
      };

      return dependencyTree;
    } catch (error) {
      console.error('Error finding downstream dependencies:', error);
      throw new Error(`Failed to find downstream dependencies: ${error}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Find all upstream business services that depend on a CI
   * Traverses upward to find business services that would be impacted
   *
   * @param ciId - Source CI identifier
   * @returns Array of business services
   */
  async findUpstreamBusinessServices(ciId: string): Promise<ImpactedBusinessService[]> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // Query to find business services that depend on this CI
      // Follows relationships upward: CI -> Application Service -> Business Service
      const query = `
        MATCH path = (ci:CI {id: $ciId})<-[r:DEPENDS_ON|RUNS_ON|USES|ENABLES|DELIVERS*1..15]-(bs:BusinessService)
        WHERE ci.id = $ciId
        WITH bs, path, length(path) as hops
        RETURN DISTINCT
               bs.id as serviceId,
               bs.name as serviceName,
               bs.bsm_attributes.annual_revenue_supported as annualRevenue,
               bs.bsm_attributes.customer_count as customerCount,
               bs.bsm_attributes.business_criticality as criticality,
               bs.bsm_attributes.business_impact_score as impactScore,
               hops,
               [rel in relationships(path) | type(rel)] as relationshipTypes
        ORDER BY annualRevenue DESC
        LIMIT 1000
      `;

      const result = await session.run(query, { ciId });

      const impactedServices: ImpactedBusinessService[] = result.records.map((record) => ({
        serviceId: record.get('serviceId'),
        serviceName: record.get('serviceName'),
        annualRevenue: record.get('annualRevenue')?.toNumber() || 0,
        customerCount: record.get('customerCount')?.toNumber() || 0,
        criticality: record.get('criticality') || 'tier_4',
        impactScore: record.get('impactScore')?.toNumber() || 0,
        relationshipPath: record.get('relationshipTypes'),
        hops: record.get('hops').toNumber(),
      }));

      return impactedServices;
    } catch (error) {
      console.error('Error finding upstream business services:', error);
      throw new Error(`Failed to find upstream business services: ${error}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Find critical path from a CI to a specific business service
   * Identifies the path and potential bottlenecks
   *
   * @param fromCiId - Source CI identifier
   * @param toServiceId - Target business service identifier
   * @returns Critical path with bottleneck analysis
   */
  async findCriticalPath(fromCiId: string, toServiceId: string): Promise<CriticalPath> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // Find shortest path using Cypher's shortestPath function
      const query = `
        MATCH path = shortestPath(
          (ci:CI {id: $fromCiId})-[r:DEPENDS_ON|RUNS_ON|USES|ENABLES|DELIVERS*..15]-(bs:BusinessService {id: $toServiceId})
        )
        WITH path, nodes(path) as pathNodes, relationships(path) as pathRels
        RETURN
          [node in pathNodes | {
            id: node.id,
            name: node.name,
            type: labels(node)[0]
          }] as nodes,
          [rel in pathRels | type(rel)] as relationships,
          length(path) as pathLength
        LIMIT 1
      `;

      const result = await session.run(query, { fromCiId, toServiceId });

      if (result.records.length === 0) {
        throw new Error(`No path found from ${fromCiId} to ${toServiceId}`);
      }

      const record = result.records[0];
      const nodes = record.get('nodes');
      const relationships = record.get('relationships');
      const pathLength = record.get('pathLength').toNumber();

      // Build critical path object
      const criticalPath: CriticalPath = {
        pathId: `${fromCiId}-to-${toServiceId}`,
        fromCiId,
        toServiceId,
        nodes: nodes.map((node: any, index: number) => ({
          ciId: node.id,
          ciName: node.name,
          ciType: node.type,
          relationshipType: relationships[index] || 'END',
        })),
        pathLength,
        totalImpactScore: 0, // Calculated separately
        bottlenecks: await this.identifyBottlenecks(nodes.map((n: any) => n.id)),
      };

      return criticalPath;
    } catch (error) {
      console.error('Error finding critical path:', error);
      throw new Error(`Failed to find critical path: ${error}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Identify bottlenecks (single points of failure)
   * A bottleneck is a node where all paths must pass through
   *
   * @param nodeIds - Array of node IDs in the path
   * @returns Array of bottleneck node IDs
   */
  private async identifyBottlenecks(nodeIds: string[]): Promise<string[]> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // For each node, check how many incoming and outgoing relationships it has
      // If it has only 1 incoming or 1 outgoing, it's a bottleneck
      const query = `
        MATCH (n:CI)
        WHERE n.id IN $nodeIds
        WITH n,
             size((n)<-[:DEPENDS_ON|RUNS_ON|USES]-()) as incomingCount,
             size((n)-[:DEPENDS_ON|RUNS_ON|USES]->()) as outgoingCount
        WHERE incomingCount = 1 OR outgoingCount = 1
        RETURN n.id as bottleneckId
      `;

      const result = await session.run(query, { nodeIds });
      return result.records.map((record) => record.get('bottleneckId'));
    } catch (error) {
      console.error('Error identifying bottlenecks:', error);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Propagate business criticality down the dependency chain
   * When a high-criticality service depends on a CI, that CI inherits elevated criticality
   *
   * @param serviceId - Business service ID to propagate from
   * @param criticality - Criticality level to propagate
   * @param maxDepth - Maximum depth to propagate (default: 5)
   */
  async propagateCriticality(
    serviceId: string,
    criticality: BusinessCriticality,
    maxDepth: number = 5
  ): Promise<number> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // Update all downstream CIs with minimum criticality
      // Only elevate criticality, never downgrade
      const criticalityOrder = ['tier_0', 'tier_1', 'tier_2', 'tier_3', 'tier_4'];
      const targetLevel = criticalityOrder.indexOf(criticality);

      const query = `
        MATCH path = (bs:BusinessService {id: $serviceId})-[r:DEPENDS_ON|RUNS_ON|USES|ENABLES|DELIVERS*1..${maxDepth}]->(ci:CI)
        WHERE bs.id = $serviceId
        WITH ci, length(path) as depth
        WITH ci, min(depth) as minDepth
        WHERE minDepth <= $maxDepth
          AND (
            ci.business_criticality IS NULL
            OR ci.business_criticality IN ['tier_3', 'tier_4']
            OR (ci.business_criticality = 'tier_2' AND $criticality IN ['tier_0', 'tier_1'])
            OR (ci.business_criticality = 'tier_1' AND $criticality = 'tier_0')
          )
        SET ci.business_criticality = $criticality,
            ci.criticality_inherited_from = $serviceId,
            ci.criticality_updated_at = datetime()
        RETURN count(ci) as updatedCount
      `;

      const result = await session.run(query, { serviceId, criticality, maxDepth });
      const updatedCount = result.records[0]?.get('updatedCount').toNumber() || 0;

      console.log(
        `Propagated criticality ${criticality} to ${updatedCount} CIs from service ${serviceId}`
      );
      return updatedCount;
    } catch (error) {
      console.error('Error propagating criticality:', error);
      throw new Error(`Failed to propagate criticality: ${error}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Find all CIs within blast radius
   * Returns all CIs that would be affected if source CI fails
   *
   * @param ciId - Source CI identifier
   * @param options - Blast radius options
   * @returns Array of impacted CIs
   */
  async findBlastRadius(ciId: string, options?: BlastRadiusOptions): Promise<ImpactedCI[]> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();
    const maxHops = options?.maxHops || 10;

    try {
      const query = `
        MATCH path = (source:CI {id: $ciId})<-[r:DEPENDS_ON|RUNS_ON|CONNECTS_TO|USES*1..${maxHops}]-(impacted:CI)
        WHERE source.id = $ciId
          ${options?.includeInactive ? '' : 'AND impacted.status = "active"'}
        WITH impacted, path, length(path) as hops
        RETURN DISTINCT
               impacted.id as ciId,
               impacted.name as ciName,
               impacted.type as ciType,
               impacted.business_criticality as criticality,
               impacted.bsm_attributes.impact_score as impactScore,
               hops,
               [rel in relationships(path) | type(rel)] as relationshipPath
        ORDER BY hops, impactScore DESC
        LIMIT 10000
      `;

      const result = await session.run(query, { ciId });

      const impactedCIs: ImpactedCI[] = result.records
        .map((record) => ({
          ciId: record.get('ciId'),
          ciName: record.get('ciName'),
          ciType: record.get('ciType'),
          relationshipPath: record.get('relationshipPath'),
          hops: record.get('hops').toNumber(),
          criticality: record.get('criticality') || 'tier_4',
          impactScore: record.get('impactScore')?.toNumber() || 0,
        }))
        .filter((ci) => {
          // Apply minimum impact score filter if specified
          if (options?.minImpactScore && ci.impactScore < options.minImpactScore) {
            return false;
          }
          return true;
        });

      return impactedCIs;
    } catch (error) {
      console.error('Error finding blast radius:', error);
      throw new Error(`Failed to find blast radius: ${error}`);
    } finally {
      await session.close();
    }
  }
}

/**
 * Singleton instance
 */
let graphTraversalInstance: GraphTraversal | null = null;

/**
 * Get Graph Traversal instance (singleton)
 */
export function getGraphTraversal(): GraphTraversal {
  if (!graphTraversalInstance) {
    graphTraversalInstance = new GraphTraversal();
  }
  return graphTraversalInstance;
}
