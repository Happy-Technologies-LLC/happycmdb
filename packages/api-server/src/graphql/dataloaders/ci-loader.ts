// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/dataloaders/ci-loader.ts

import DataLoader from 'dataloader';
import neo4j, { type Node, type Relationship } from 'neo4j-driver';
import {
  Neo4jClient, CITraversalLimitError, MAX_CI_TRAVERSAL_NODES,
  runWithinCITraversalBudget, type CITraversalWork,
} from '@cmdb/database';
import { CI } from '@cmdb/common';

/**
 * Key of every CI dataloader: the CI id plus the caller's organization. The
 * organization is part of the cache key and of the Cypher match, so a lookup
 * for one organization can never be answered from (or with) another
 * organization's CI, even if a loader instance were shared.
 */
export interface CILoaderKey {
  id: string;
  organizationId: string;
}

/** Cache key of a CILoaderKey; throws on a key without an organization. */
function cacheKey(key: CILoaderKey): string {
  if (
    !key ||
    typeof key.id !== 'string' ||
    typeof key.organizationId !== 'string' ||
    key.organizationId.length === 0
  ) {
    throw new TypeError('CI dataloader keys require an id and an organizationId');
  }
  return JSON.stringify([key.organizationId, key.id]);
}

/** Plain Cypher parameter maps for a batch of keys. */
function keyParams(keys: readonly CILoaderKey[]): Array<{ id: string; organizationId: string }> {
  return keys.map(({ id, organizationId }) => ({ id, organizationId }));
}

/** One hop of a relationship lookup: the relationship type, the CI on the far end, and its properties. */
export interface RelatedCIEntry {
  _type: string;
  _ci: CI;
  _properties: Record<string, unknown>;
}

function nodeToCI(node: Node): CI {
  const props = node.properties;
  return {
    _id: props.id,
    external_id: props.external_id,
    name: props.name,
    _type: props.type,
    _status: props.status,
    environment: props.environment,
    _created_at: props.created_at,
    _incarnation_id: props.incarnation_id,
    _updated_at: props.updated_at,
    _discovered_at: props.discovered_at,
    _metadata: props.metadata ? JSON.parse(props.metadata) : {},
  };
}

const loaderOptions = {
  cacheKeyFn: cacheKey,
  // Batch multiple requests in single tick
  batchScheduleFn: (callback: () => void) => setTimeout(callback, 10),
};

/**
 * DataLoader for batching and caching CI lookups within one organization.
 * Prevents N+1 query problem when resolving relationships. A CI of another
 * organization resolves to null, exactly like a missing one.
 */
export function createCILoader(neo4jClient: Neo4jClient): DataLoader<CILoaderKey, CI | null, string> {
  return new DataLoader<CILoaderKey, CI | null, string>(
    async (keys: readonly CILoaderKey[]) => {
      const session = neo4jClient.getSession();

      try {
        const result = await session.run(
          `
          UNWIND $keys AS key
          OPTIONAL MATCH (ci:CI {id: key.id})
          WHERE ci.organization_id = key.organizationId
          RETURN key.id AS ciId, key.organizationId AS organizationId, ci
          `,
          { keys: keyParams(keys) }
        );

        const ciMap = new Map<string, CI>();
        result.records.forEach(record => {
          const ciNode: Node | null = record.get('ci');
          if (ciNode) {
            ciMap.set(
              cacheKey({ id: record.get('ciId'), organizationId: record.get('organizationId') }),
              nodeToCI(ciNode)
            );
          }
        });

        // Return results in the same order as requested keys
        return keys.map(key => ciMap.get(cacheKey(key)) ?? null);
      } finally {
        await session.close();
      }
    },
    loaderOptions
  );
}

/**
 * Batched one-hop relationship lookups in one direction. Both the CI and the
 * related CI must be in the key's organization.
 */
function createDirectedRelationshipLoader(
  neo4jClient: Neo4jClient, getWork: () => CITraversalWork,
  pattern: '(ci:CI {id: key.id})-[r]->(related:CI)' | '(ci:CI {id: key.id})<-[r]-(related:CI)'
): DataLoader<CILoaderKey, RelatedCIEntry[], string> {
  return new DataLoader<CILoaderKey, RelatedCIEntry[], string>(
    async (keys: readonly CILoaderKey[]) => {
      const session = neo4jClient.getSession();

      try {
        const work = getWork();
        const records = await runWithinCITraversalBudget(work, async rowLimit => {
          const result = await session.run(
            `
            UNWIND $keys AS key
            OPTIONAL MATCH ${pattern}
            WHERE ci.organization_id = key.organizationId
              AND related.organization_id = key.organizationId
            RETURN key.id AS ciId, key.organizationId AS organizationId,
                   type(r) AS relType, related, r AS relationship
            LIMIT $rowLimit
            `,
            { keys: keyParams(keys), rowLimit: neo4j.int(rowLimit) },
            { timeout: 5000 }
          );
          return result.records;
        });
        for (const key of keys) work.nodes.add(key.id);
        if (work.nodes.size > MAX_CI_TRAVERSAL_NODES) throw new CITraversalLimitError();
        // Group relationships by cache key
        const relationshipMap = new Map<string, RelatedCIEntry[]>();
        records.forEach(record => {
          const relatedNode: Node | null = record.get('related');
          if (!relatedNode) {
            return;
          }
          const key = cacheKey({ id: record.get('ciId'), organizationId: record.get('organizationId') });
          work.nodes.add(relatedNode.properties['id'] as string);
          if (work.nodes.size > MAX_CI_TRAVERSAL_NODES) throw new CITraversalLimitError();
          const relationships = relationshipMap.get(key) ?? [];
          const relationship: Relationship = record.get('relationship');
          relationships.push({
            _type: record.get('relType'),
            _ci: nodeToCI(relatedNode),
            _properties: relationship.properties,
          });
          relationshipMap.set(key, relationships);
        });

        // Return results in order
        return keys.map(key => relationshipMap.get(cacheKey(key)) ?? []);
      } finally {
        await session.close();
      }
    },
    loaderOptions
  );
}

/**
 * DataLoader for batching outgoing relationship lookups
 */
export function createRelationshipLoader(
  neo4jClient: Neo4jClient, getWork: () => CITraversalWork
): DataLoader<CILoaderKey, RelatedCIEntry[], string> {
  return createDirectedRelationshipLoader(neo4jClient, getWork, '(ci:CI {id: key.id})-[r]->(related:CI)');
}

/**
 * DataLoader for batching incoming relationship lookups (dependents)
 */
export function createDependentLoader(
  neo4jClient: Neo4jClient, getWork: () => CITraversalWork
): DataLoader<CILoaderKey, RelatedCIEntry[], string> {
  return createDirectedRelationshipLoader(neo4jClient, getWork, '(ci:CI {id: key.id})<-[r]-(related:CI)');
}
