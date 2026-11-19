// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import ciService, { CIRelationship, ImpactAnalysis } from '../services/ci.service';
import { CI_QUERY_KEYS } from './useCIs';
import { useMemo } from 'react';

export function useCIRelationships(ciId: string, enabled = true, depth = 1) {
  return useQuery({
    queryKey: [...CI_QUERY_KEYS.relationships(ciId), depth],
    queryFn: () => ciService.getCIRelationships(ciId, depth),
    enabled: enabled && !!ciId,
    staleTime: 30000,
    gcTime: 300000,
  });
}

export function useImpactAnalysis(ciId: string, enabled = true) {
  return useQuery({
    queryKey: CI_QUERY_KEYS.impact(ciId),
    queryFn: () => ciService.getImpactAnalysis(ciId),
    enabled: enabled && !!ciId,
    staleTime: 30000,
    gcTime: 300000,
  });
}

/** The impact read with its basis, coverage and per-edge evidence envelope (null on a server that sends none). */
export function useImpactEnvelope(ciId: string, enabled = true) {
  return useQuery({
    queryKey: CI_QUERY_KEYS.impactEnvelope(ciId),
    queryFn: () => ciService.getImpactEnvelope(ciId),
    enabled: enabled && !!ciId,
    staleTime: 30000,
    gcTime: 300000,
  });
}

export const EVIDENCE_PAGE_SIZE = 20;

/**
 * Receipts of one edge, newest first, 20 per page. The key carries from, to and type, so one edge's rows are never
 * served for another. Fetches only while `enabled` (the drawer is open).
 */
export function useRelationshipEvidence(fromId: string, toId: string, type: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: CI_QUERY_KEYS.relationshipEvidence(fromId, toId, type),
    queryFn: ({ pageParam }) =>
      ciService.getRelationshipEvidence(fromId, toId, type, { limit: EVIDENCE_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.pagination.offset + last.pagination.count;
      return last.pagination.count > 0 && next < last.pagination.total ? next : undefined;
    },
    // Offset paging over a newest-first list: a receipt written while the drawer is open shifts later pages by one
    // and repeats the previous page's last receipt. Keep the first occurrence of each receipt_id.
    select: (data) => {
      const seen = new Set<string>();
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          receipts: page.receipts.filter((r) => !seen.has(r.receipt_id) && !!seen.add(r.receipt_id)),
        })),
      };
    },
    enabled: enabled && !!fromId && !!toId && !!type,
    retry: false,
    staleTime: 0,
  });
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  status: string;
  environment: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: string;
}

export interface RelationshipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function useRelationshipGraph(ciId: string, enabled = true, depth = 1) {
  const { data: relationships, ...query } = useCIRelationships(ciId, enabled, depth);

  const graph = useMemo<RelationshipGraph>(() => {
    if (!relationships) {
      return { nodes: [], edges: [] };
    }

    const nodesMap = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    relationships.forEach((rel) => {
      // Add source node
      if (rel.source_ci && !nodesMap.has(rel.source_ci.id)) {
        nodesMap.set(rel.source_ci.id, {
          id: rel.source_ci.id,
          label: rel.source_ci.name,
          type: rel.source_ci.type,
          status: rel.source_ci.status,
          environment: rel.source_ci.environment,
        });
      }

      // Add target node
      if (rel.target_ci && !nodesMap.has(rel.target_ci.id)) {
        nodesMap.set(rel.target_ci.id, {
          id: rel.target_ci.id,
          label: rel.target_ci.name,
          type: rel.target_ci.type,
          status: rel.target_ci.status,
          environment: rel.target_ci.environment,
        });
      }

      // Add edge
      edges.push({
        id: rel.id,
        source: rel.source_ci_id,
        target: rel.target_ci_id,
        label: rel.type,
        type: rel.type,
      });
    });

    return {
      nodes: Array.from(nodesMap.values()),
      edges,
    };
  }, [relationships]);

  return {
    ...query,
    data: relationships,
    graph,
  };
}

export function useRelationshipsByType(ciId: string, relationshipType?: string) {
  const { data: relationships, ...query } = useCIRelationships(ciId);

  const filtered = useMemo(() => {
    if (!relationships) return [];
    if (!relationshipType) return relationships;
    return relationships.filter((rel) => rel.type === relationshipType);
  }, [relationships, relationshipType]);

  return {
    ...query,
    data: filtered,
  };
}

export function useUpstreamDependencies(ciId: string) {
  const { data: relationships, ...query } = useCIRelationships(ciId);

  const upstream = useMemo(() => {
    if (!relationships) return [];
    return relationships.filter((rel) => rel.target_ci_id === ciId);
  }, [relationships, ciId]);

  return {
    ...query,
    data: upstream,
  };
}

export function useDownstreamDependencies(ciId: string) {
  const { data: relationships, ...query } = useCIRelationships(ciId);

  const downstream = useMemo(() => {
    if (!relationships) return [];
    return relationships.filter((rel) => rel.source_ci_id === ciId);
  }, [relationships, ciId]);

  return {
    ...query,
    data: downstream,
  };
}

export function useRelationshipStats(ciId: string) {
  const { data: relationships, ...query } = useCIRelationships(ciId);

  const stats = useMemo(() => {
    if (!relationships) {
      return {
        total: 0,
        upstream: 0,
        downstream: 0,
        byType: {} as Record<string, number>,
      };
    }

    const byType: Record<string, number> = {};
    let upstream = 0;
    let downstream = 0;

    relationships.forEach((rel) => {
      // Count by type
      byType[rel.type] = (byType[rel.type] || 0) + 1;

      // Count direction
      if (rel.source_ci_id === ciId) {
        downstream++;
      } else {
        upstream++;
      }
    });

    return {
      total: relationships.length,
      upstream,
      downstream,
      byType,
    };
  }, [relationships, ciId]);

  return {
    ...query,
    stats,
  };
}
