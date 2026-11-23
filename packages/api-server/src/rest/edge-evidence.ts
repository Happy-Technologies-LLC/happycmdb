// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { CITraversalLimitError, getNeo4jClient, getPostgresClient, type CIEdgeRef } from '@cmdb/database';

import { boundedStatementTimeoutMs } from './statement-timeout';

/**
 * HAP-2030 (evidence-qualified relationships, story 3): per-edge evidence and DERIVED currentness for the impact reads.
 * A receipt (HAP-2029) is the proof; currentness is computed from receipts at read time against the database clock and is
 * never stored. A missing receipt is `unsupported`, never `current`. The incarnation fence and the organization predicate
 * make receipts of another organization, a deleted CI or a re-created CI inert.
 */
export type EdgeCurrentness = 'current' | 'stale' | 'contradicted' | 'unsupported';
export type EvidenceClass = 'declared' | 'static_observed' | 'runtime_observed' | 'inferred';
export type EvidencePolarity = 'supports' | 'contradicts';

/** The fixed order `evidence.classes` is reported in. */
export const EVIDENCE_CLASS_ORDER: readonly EvidenceClass[] = ['declared', 'static_observed', 'runtime_observed', 'inferred'];

/**
 * Policy constants (operator choice, tunable here, not by environment): how long a supporting receipt of a class keeps an edge
 * `current`. A hand-declared edge is re-asserted rarely; a connector-observed one must be re-observed by its source (the AI
 * sync re-observes at most daily); runtime observations only mean something when near-continuous; `inferred` never makes an
 * edge current.
 */
export const EDGE_FRESHNESS_WINDOWS_DAYS: Readonly<Record<EvidenceClass, number | null>> = {
  declared: 180, static_observed: 7, runtime_observed: 1, inferred: null,
};

/** Newest receipts of one edge the read scans; the ceiling of the receipts read route's `limit`. */
export const EDGE_EVIDENCE_SCAN_CAP = 200;
/** Guard, not a feature: the real traversal bounds cap at about 800 and 200 edges. */
export const MAX_EDGE_EVIDENCE_EDGES = 1000;
/** statement_timeout of the evidence read, in milliseconds; `IMPACT_EVIDENCE_TIMEOUT_MS` overrides it like the lineage knob. */
export const IMPACT_EVIDENCE_TIMEOUT_MS = 3000;

export function impactEvidenceTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedStatementTimeoutMs(env['IMPACT_EVIDENCE_TIMEOUT_MS'], IMPACT_EVIDENCE_TIMEOUT_MS);
}

const DAY_MS = 86_400_000;

/** One aggregate row of an edge's scanned receipts. */
export interface EvidenceRow {
  evidence_class: EvidenceClass;
  polarity: EvidencePolarity;
  n: number;
  newest: Date | string;
}

export interface EdgeEvidence {
  classes: EvidenceClass[];
  support: { supports: number; contradicts: number };
  receipt_count: number;
  receipts_truncated: boolean;
  last_supported_at: string | null;
  receipts_href: string;
}

export interface EdgeQualification {
  currentness: EdgeCurrentness;
  evidence: EdgeEvidence;
}

/** Lookup key of an edge: stored start CI, stored end CI and the Neo4j relationship type. Direction matters. */
export function edgeKey(from: string, to: string, type: string): string {
  return JSON.stringify([from, to, type]);
}

const time = (value: Date | string): number => new Date(value).getTime();
const newestOf = (times: number[]): number | null => (times.length === 0 ? null : Math.max(...times));

/**
 * The currentness of one edge from the aggregate rows of its newest scanned receipts and `readAt`, the database clock of the
 * same statement. Rules, first match wins: no receipts is `unsupported`; a contradiction no strictly newer effective support
 * supersedes is `contradicted` (a tie is `contradicted`); only `inferred` supports is `stale`; a supporting class whose own
 * newest support is inside its window (inclusive) is `current`, else `stale`.
 */
export function deriveCurrentness(rows: readonly EvidenceRow[], readAt: Date): EdgeCurrentness {
  if (rows.length === 0 || rows.every(row => row.n === 0)) {
return 'unsupported';
}
  const effective = rows.filter(row => row.polarity === 'supports' && row.evidence_class !== 'inferred');
  const newestSupport = newestOf(effective.map(row => time(row.newest)));
  const newestContradict = newestOf(rows.filter(row => row.polarity === 'contradicts').map(row => time(row.newest)));
  if (newestContradict !== null && (newestSupport === null || newestContradict >= newestSupport)) {
return 'contradicted';
}
  if (newestSupport === null) {
return 'stale';
}
  const now = readAt.getTime();
  const inWindow = effective.some(row => {
    const days = EDGE_FRESHNESS_WINDOWS_DAYS[row.evidence_class];
    return days !== null && now - time(row.newest) <= days * DAY_MS;
  });
  return inWindow ? 'current' : 'stale';
}

/** Receipts read route of Story 2 (`GET /api/v1/relationships/evidence`), built only from ids already in the response. */
function receiptsHref(from: string, to: string, type: string): string {
  return `/api/v1/relationships/evidence?${new URLSearchParams({ from_id: from, to_id: to, type }).toString()}`;
}

/** The coarse aggregate of one edge's scanned receipts. Never carries an organization, incarnation, source or observer. */
export function summarizeEvidence(from: string, to: string, type: string, rows: readonly EvidenceRow[]): EdgeEvidence {
  const supporting = rows.filter(row => row.polarity === 'supports' && row.n > 0);
  const count = (polarity: EvidencePolarity): number =>
    rows.filter(row => row.polarity === polarity).reduce((sum, row) => sum + row.n, 0);
  const supports = count('supports');
  const contradicts = count('contradicts');
  const lastSupported = newestOf(supporting.map(row => time(row.newest)));
  return {
    classes: EVIDENCE_CLASS_ORDER.filter(cls => supporting.some(row => row.evidence_class === cls)),
    support: { supports, contradicts },
    receipt_count: supports + contradicts,
    receipts_truncated: supports + contradicts >= EDGE_EVIDENCE_SCAN_CAP,
    last_supported_at: lastSupported === null ? null : new Date(lastSupported).toISOString(),
    receipts_href: receiptsHref(from, to, type),
  };
}

function qualification(edge: CIEdgeRef, rows: readonly EvidenceRow[], readAt: Date): EdgeQualification {
  return { currentness: deriveCurrentness(rows, readAt), evidence: summarizeEvidence(edge.from, edge.to, edge.type, rows) };
}

export const EVIDENCE_STATEMENT = `
  WITH e(from_id, to_id, rel_type, from_inc, to_inc) AS
    (SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::uuid[], $6::uuid[]))
  SELECT e.from_id, e.to_id, e.rel_type, s.evidence_class, s.polarity, s.n, s.newest, now() AS read_at
  FROM e LEFT JOIN LATERAL (
    SELECT evidence_class, polarity, count(*)::int AS n, max(observed_at) AS newest FROM (
      SELECT r.evidence_class, r.polarity, r.observed_at FROM relationship_evidence_receipts r
      WHERE r.organization_id = $1 AND r.from_ci_id = e.from_id AND r.to_ci_id = e.to_id
        AND r.relationship_type = e.rel_type
        AND r.from_incarnation_id = e.from_inc AND r.to_incarnation_id = e.to_inc
      ORDER BY r.observed_at DESC, r.receipt_id LIMIT ${EDGE_EVIDENCE_SCAN_CAP}) newest_receipts
    GROUP BY evidence_class, polarity) s ON true`;

/**
 * Qualify every edge of one impact read: ONE Neo4j read of the endpoints' current incarnations, then ONE PostgreSQL
 * statement over all edges, in a short transaction under its own statement_timeout (no per-edge query, ever; nothing at all
 * for no edges). The organization is the verified caller's; the incarnations come from the graph, never from the request or
 * the receipts. An endpoint the organization does not own, that no longer exists, or that has no incarnation yet (a legacy
 * CI: a read assigns none) has no receipt to find: its edges are `unsupported` and never reach PostgreSQL.
 * Any failure rejects: the caller answers its fixed 503/504/500 with no members, never an optimistic or partial body.
 * `timeoutMs` bounds the Neo4j read.
 */
export async function loadEdgeEvidence(
  organizationId: string, edges: readonly CIEdgeRef[], options: { timeoutMs: number }
): Promise<Map<string, EdgeQualification>> {
  if (edges.length > MAX_EDGE_EVIDENCE_EDGES) {
    throw new CITraversalLimitError();
  }
  const unique = new Map<string, CIEdgeRef>();
  for (const edge of edges) {
    unique.set(edgeKey(edge.from, edge.to, edge.type), edge);
  }
  const result = new Map<string, EdgeQualification>();
  if (unique.size === 0) {
    return result;
  }

  const incarnations = await getNeo4jClient().getCIIncarnations(
    [...new Set([...unique.values()].flatMap(edge => [edge.from, edge.to]))], organizationId, options.timeoutMs);
  const fenced: Array<{ key: string; edge: CIEdgeRef; fromInc: string; toInc: string }> = [];
  for (const [key, edge] of unique) {
    const fromInc = incarnations.get(edge.from);
    const toInc = incarnations.get(edge.to);
    if (fromInc !== null && fromInc !== undefined && toInc !== null && toInc !== undefined) {
      fenced.push({ key, edge, fromInc, toInc });
    } else {
      result.set(key, qualification(edge, [], new Date(0)));
    }
  }
  if (fenced.length === 0) {
    return result;
  }

  const rows = (await getPostgresClient().transaction(async client => {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(impactEvidenceTimeoutMs())]);
    return client.query(EVIDENCE_STATEMENT, [organizationId, fenced.map(f => f.edge.from), fenced.map(f => f.edge.to),
      fenced.map(f => f.edge.type), fenced.map(f => f.fromInc), fenced.map(f => f.toInc)]);
  })).rows as Array<{ from_id: string; to_id: string; rel_type: string; evidence_class: EvidenceClass | null;
    polarity: EvidencePolarity | null; n: number | null; newest: Date | string | null; read_at: Date | string }>;

  const byEdge = new Map<string, EvidenceRow[]>();
  let readAt = new Date(0);
  for (const row of rows) {
    readAt = new Date(row.read_at);
    if (row.evidence_class === null || row.polarity === null || row.n === null || row.newest === null) {
      continue;
    }
    const key = edgeKey(row.from_id, row.to_id, row.rel_type);
    const list = byEdge.get(key) ?? [];
    list.push({ evidence_class: row.evidence_class, polarity: row.polarity, n: row.n, newest: row.newest });
    byEdge.set(key, list);
  }
  for (const { key, edge } of fenced) {
    result.set(key, qualification(edge, byEdge.get(key) ?? [], readAt));
  }
  return result;
}

/** The qualification of `edge` from a `loadEdgeEvidence` result; an edge that was never loaded is a programming error. */
export function qualificationOf(qualified: ReadonlyMap<string, EdgeQualification>, from: string, to: string, type: string): EdgeQualification {
  const found = qualified.get(edgeKey(from, to, type));
  if (found === undefined) {
    throw new Error('Edge was not qualified');
  }
  return found;
}

export interface QualifiedEdge extends EdgeQualification { from: string; to: string; type: string }

/** The edges of a traversal, deduplicated by `(from,to,type)` and sorted for a stable body, each with its qualification. */
export function qualifyEdges(edges: readonly CIEdgeRef[], qualified: ReadonlyMap<string, EdgeQualification>): QualifiedEdge[] {
  const unique = new Map<string, CIEdgeRef>();
  for (const edge of edges) {
    unique.set(edgeKey(edge.from, edge.to, edge.type), edge);
  }
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const orderEdges = (a: CIEdgeRef, b: CIEdgeRef): number =>
    order(a.from, b.from) || order(a.to, b.to) || order(a.type, b.type);
  return [...unique.values()]
    .sort(orderEdges)
    .map(edge => ({ from: edge.from, to: edge.to, type: edge.type, ...qualificationOf(qualified, edge.from, edge.to, edge.type) }));
}
