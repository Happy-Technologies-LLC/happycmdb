// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Estate topology summary (HAP-1924, UX-4b BW3): types and the CI type -> estate category table
 * behind GET /analytics/topology-summary.
 */

import type { CIType } from './ci.types';

/** The four estate hub rings. `critical` is a separate count on the summary, not a category. */
export type TopologyCategory = 'services' | 'apps' | 'data' | 'infra';

/**
 * The ONE CI `type` -> estate category table. Typed `Record<CIType, ...>` so adding a CI type without
 * deciding its ring is a compile error. Non-asset record types (alerts, identities, ...) sit under
 * `infra`, the catch-all ring; a stored type that is not in this table (drift, or a connector type
 * outside the enum) also counts under `infra` and is reported in `unmapped_types`.
 */
export const TOPOLOGY_CATEGORY_BY_TYPE: Readonly<Record<CIType, TopologyCategory>> = {
  service: 'services',
  application: 'apps',
  software: 'apps',
  'agent-release': 'apps',
  'ai-model': 'apps',
  'ai-deployment': 'apps',
  database: 'data',
  storage: 'data',
  server: 'infra',
  'virtual-machine': 'infra',
  container: 'infra',
  'network-device': 'infra',
  'load-balancer': 'infra',
  'cloud-resource': 'infra',
  'hardware-component': 'infra',
  'mobile-device': 'infra',
  cell: 'infra',
  alert: 'infra',
  vulnerability: 'infra',
  detection: 'infra',
  incident: 'infra',
  policy: 'infra',
  configuration: 'infra',
  user: 'infra',
  group: 'infra',
  'organizational-unit': 'infra',
  collection: 'infra',
  update: 'infra',
};

/** Category of a stored CI type; `mapped: false` marks drift (counted under `infra`). */
export function topologyCategoryOf(type: string | null | undefined): { category: TopologyCategory; mapped: boolean } {
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(TOPOLOGY_CATEGORY_BY_TYPE, type)) {
    return { category: TOPOLOGY_CATEGORY_BY_TYPE[type as CIType], mapped: true };
  }
  return { category: 'infra', mapped: false };
}

export const TOPOLOGY_NODE_LIMIT_DEFAULT = 200;
export const TOPOLOGY_NODE_LIMIT_MAX = 500;
export const TOPOLOGY_EDGE_LIMIT_DEFAULT = 400;
export const TOPOLOGY_EDGE_LIMIT_MAX = 1000;

export interface TopologyCategoryCounts {
  services: number;
  apps: number;
  data: number;
  infra: number;
  /** CIs with bsm_business_criticality tier_1 or tier_2 (any category). */
  critical: number;
}

export interface TopologyNode {
  id: string;
  name: string;
  type: string;
  category: TopologyCategory;
  status: string | null;
  critical: boolean;
  /** CI health state is BW1 and does not exist yet; the key is kept so the UI contract is stable. */
  health: null;
}

export interface TopologyEdge {
  source: string;
  target: string;
  type: string;
}

export interface TopologySummary {
  categories: TopologyCategoryCounts;
  /** Stored CI types missing from TOPOLOGY_CATEGORY_BY_TYPE (counted under infra), sorted. */
  unmapped_types: string[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  totals: {
    cis: number;
    relationships: number;
    nodes_returned: number;
    edges_returned: number;
    /** True when the node cap or the edge cap cut data. */
    truncated: boolean;
  };
}
