// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ImpactEdge } from '../../services/ci.service';

/** Stored orientation: `from` is the start CI of the relationship, whichever way the traversal walked. */
export function edgeKey(from: string, to: string, type: string): string {
  return JSON.stringify([from, to, type]);
}

/** Index the envelope's edges by (from, to, type). A relationship the server does not qualify has no entry. */
export function indexEdges(edges: readonly ImpactEdge[] | undefined): Map<string, ImpactEdge> {
  const index = new Map<string, ImpactEdge>();
  for (const edge of edges ?? []) index.set(edgeKey(edge.from, edge.to, edge.type), edge);
  return index;
}
