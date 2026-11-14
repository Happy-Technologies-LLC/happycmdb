// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Estate topology summary (HAP-1924, UX-4b BW3): per-category counts, a capped node sample and a capped
 * edge list for one organization. Runs inside `readCIList`, so a CI with a pending or failed reconciliation
 * operation (HP1 fence, `NOT x.id IN $pending`) is absent from nodes, categories, totals, degrees and edges.
 */

import neo4j, { type Integer, type Session } from 'neo4j-driver';
import {
  TOPOLOGY_EDGE_LIMIT_DEFAULT, TOPOLOGY_EDGE_LIMIT_MAX,
  TOPOLOGY_NODE_LIMIT_DEFAULT, TOPOLOGY_NODE_LIMIT_MAX,
  topologyCategoryOf,
  type TopologyCategory, type TopologySummary,
} from '@cmdb/common';
import { CIListUnavailableError } from '../read-admission';
import { criticalTiersParam } from './critical-ci';
import { DASHBOARD_QUERY_TIMEOUT_MS, MAX_DASHBOARD_GROUPS } from './dashboard-query';

/** More distinct CI types than a summary may group: refused (503), never silently truncated. */
export class TopologyGroupLimitError extends Error {
  constructor() {
    super('Topology summary group limit exceeded');
  }
}

export interface TopologySummaryOptions {
  /** Node sample cap, already clamped. */
  nodeLimit: number;
  /** Edge cap, already clamped. */
  edgeLimit: number;
  includeInactive: boolean;
}

/** Clamp an untrusted query value to an integer in 1..max; absent or non-numeric gives the default. */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

export function parseTopologyOptions(query: Record<string, unknown>): TopologySummaryOptions {
  return {
    nodeLimit: clampLimit(query['limit'], TOPOLOGY_NODE_LIMIT_DEFAULT, TOPOLOGY_NODE_LIMIT_MAX),
    edgeLimit: clampLimit(query['edge_limit'], TOPOLOGY_EDGE_LIMIT_DEFAULT, TOPOLOGY_EDGE_LIMIT_MAX),
    includeInactive: query['includeInactive'] === 'true',
  };
}

const num = (value: number | Integer | null | undefined): number =>
  value == null ? 0 : neo4j.isInt(value) ? value.toNumber() : value;

/** Missing `type` property: counted under infra and reported in unmapped_types under this name. */
const MISSING_TYPE = '(missing)';

const NOT_DECOMMISSIONED = (alias: string): string => `coalesce(${alias}.status, 'active') <> 'decommissioned'`;
const SCOPE = (alias: string): string =>
  `${alias}.organization_id = $organizationId AND NOT ${alias}.id IN $pending`
  + ` AND ($includeInactive OR ${NOT_DECOMMISSIONED(alias)})`;
const CRITICAL = (alias: string): string => `${alias}.bsm_business_criticality IN $criticalTiers`;

export async function readTopologySummary(
  session: Session,
  organizationId: string,
  options: TopologySummaryOptions,
  pending: string[],
  budgetMs: number,
): Promise<TopologySummary> {
  const base = { organizationId, includeInactive: options.includeInactive, pending };
  const expiresAt = Date.now() + budgetMs;
  /** Per-statement timeout: the dashboard read bound, never more than what readCIList has left. */
  const timeout = (): number => {
    const left = expiresAt - Date.now();
    if (left <= 0) throw new CIListUnavailableError();
    return Math.min(left, DASHBOARD_QUERY_TIMEOUT_MS);
  };
  const groups = await session.run(`
    MATCH (ci:CI)
    WHERE ${SCOPE('ci')}
    RETURN ci.type AS type, count(ci) AS cis,
      count(CASE WHEN ${CRITICAL('ci')} THEN 1 END) AS critical
    ORDER BY type LIMIT $groupLimit
  `, { ...base, ...criticalTiersParam(), groupLimit: neo4j.int(MAX_DASHBOARD_GROUPS + 1) },
    { timeout: timeout() });
  if (groups.records.length > MAX_DASHBOARD_GROUPS) throw new TopologyGroupLimitError();

  const categories = { services: 0, apps: 0, data: 0, infra: 0, critical: 0 };
  const unmapped: string[] = [];
  let cis = 0;
  for (const record of groups.records) {
    const type = record.get('type') as string | null;
    const { category, mapped } = topologyCategoryOf(type);
    const count = num(record.get('cis'));
    categories[category] += count;
    categories.critical += num(record.get('critical'));
    cis += count;
    if (!mapped) unmapped.push(type ?? MISSING_TYPE);
  }

  const relationships = await session.run(`
    MATCH (source:CI)-[r]->(target:CI)
    WHERE ${SCOPE('source')} AND ${SCOPE('target')}
    RETURN count(r) AS relationships
  `, base, { timeout: timeout() });

  // Critical first, then highest degree, then id. coalesce keeps null criticality out of the
  // "null sorts first under DESC" trap.
  const sample = await session.run(`
    MATCH (ci:CI)
    WHERE ${SCOPE('ci')}
    WITH ci, coalesce(${CRITICAL('ci')}, false) AS critical,
      COUNT { (ci)-[]-(neighbor:CI) WHERE ${SCOPE('neighbor')} } AS degree
    ORDER BY critical DESC, degree DESC, ci.id ASC LIMIT $nodeLimit
    RETURN ci.id AS id, coalesce(ci.name, ci.id) AS name, ci.type AS type, ci.status AS status, critical
    ORDER BY critical DESC, degree DESC, id ASC
  `, { ...base, ...criticalTiersParam(), nodeLimit: neo4j.int(options.nodeLimit) },
    { timeout: timeout() });
  const nodes = sample.records.map(record => {
    const type = record.get('type') as string | null;
    return {
      id: record.get('id') as string,
      name: record.get('name') as string,
      type: type ?? MISSING_TYPE,
      category: topologyCategoryOf(type).category as TopologyCategory,
      status: (record.get('status') as string | null) ?? null,
      critical: record.get('critical') as boolean,
      health: null,
    };
  });

  // Both ends in the sample. One extra row says whether the cap cut anything.
  const edgeRows = nodes.length === 0 ? [] : (await session.run(`
    MATCH (source:CI)-[r]->(target:CI)
    WHERE source.organization_id = $organizationId AND target.organization_id = $organizationId
      AND source.id IN $ids AND target.id IN $ids
      AND NOT source.id IN $pending AND NOT target.id IN $pending
    RETURN source.id AS source, target.id AS target, type(r) AS type
    ORDER BY source, target, type LIMIT $edgeLimit
  `, {
    organizationId, pending, ids: nodes.map(node => node.id), edgeLimit: neo4j.int(options.edgeLimit + 1),
  }, { timeout: timeout() })).records;
  const edges = edgeRows.slice(0, options.edgeLimit).map(record => ({
    source: record.get('source') as string,
    target: record.get('target') as string,
    type: record.get('type') as string,
  }));

  return {
    categories,
    unmapped_types: unmapped.sort(),
    nodes,
    edges,
    totals: {
      cis,
      relationships: num(relationships.records[0]?.get('relationships')),
      nodes_returned: nodes.length,
      edges_returned: edges.length,
      truncated: nodes.length < cis || edgeRows.length > options.edgeLimit,
    },
  };
}
