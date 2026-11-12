// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1252 S2 (HAP-1916): the pure rules of the estate hub: which category a CI belongs to, how a capped topology
 * sample is built from the two list endpoints that exist today, where the orbit puts a dot, and what the incident
 * ribbon may claim. No React, no network.
 *
 * The estate topology summary endpoint (BW3) is not on main, so the hub shows a capped, labelled sample: nodes from
 * GET /cis and from the endpoints of GET /relationships, never invented ones.
 */

import { forbiddenReason } from './forbidden';

export type Category = 'services' | 'apps' | 'data' | 'infra';

export const CATEGORY_ORDER: readonly Category[] = ['services', 'apps', 'data', 'infra'];

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  services: 'Services',
  apps: 'Apps',
  data: 'Data',
  infra: 'Infra',
};

const CATEGORY_OF_TYPE: Readonly<Record<string, Category>> = {
  service: 'services',
  application: 'apps',
  database: 'data',
  storage: 'data',
};

/** The stage category of a CI `type` (the 10-value enum in services/ci.service.ts); every other type is infrastructure. */
export const categoryOf = (type: string): Category => CATEGORY_OF_TYPE[type] ?? 'infra';

/** Full-estate CI counts per category, from the `by_type` counts of GET /analytics/dashboard. */
export function categoryCounts(byType: Readonly<Record<string, number>>): Record<Category, number> {
  const counts: Record<Category, number> = { services: 0, apps: 0, data: 0, infra: 0 };
  for (const [type, count] of Object.entries(byType)) counts[categoryOf(type)] += count;
  return counts;
}

/** One row of GET /relationships (controllers/relationship.controller.ts listRelationships). */
export interface RelationshipRow {
  from_id: string;
  from_name: string;
  from_type: string;
  to_id: string;
  to_name: string;
  to_type: string;
  type: string;
}

export interface EstateNode {
  id: string;
  name: string;
  type: string;
  category: Category;
}

export interface EstateEdge {
  source: string;
  target: string;
  type: string;
}

export interface EstateSample {
  nodes: EstateNode[];
  edges: EstateEdge[];
}

/** The most CIs the stage draws. The orbit and the graph stay legible and the first paint stays cheap. */
export const SAMPLE_NODE_CAP = 150;

const node = (id: string, name: string, type: string): EstateNode => ({
  id,
  name,
  type,
  category: categoryOf(type),
});

/**
 * A capped sample of the estate. Connected CIs come first (both endpoints of a relationship, while they fit), then
 * the CI list fills what is left. An edge is kept only when both of its endpoints are in the sample, so the
 * renderers never draw a line to nothing. A CI seen in both sources is one node.
 */
export function buildSample(
  cis: readonly { id: string; name: string; type: string }[],
  relationships: readonly RelationshipRow[],
  cap: number = SAMPLE_NODE_CAP
): EstateSample {
  const nodes = new Map<string, EstateNode>();
  for (const r of relationships) {
    const ends = [node(r.from_id, r.from_name, r.from_type), node(r.to_id, r.to_name, r.to_type)];
    const fresh = new Set(ends.filter((e) => !nodes.has(e.id)).map((e) => e.id)).size;
    if (nodes.size + fresh > cap) continue;
    for (const e of ends) if (!nodes.has(e.id)) nodes.set(e.id, e);
  }
  for (const ci of cis) {
    if (nodes.size >= cap) break;
    if (!nodes.has(ci.id)) nodes.set(ci.id, node(ci.id, ci.name, ci.type));
  }
  const seen = new Set<string>();
  const edges: EstateEdge[] = [];
  for (const r of relationships) {
    const key = `${r.from_id}|${r.type}|${r.to_id}`;
    if (seen.has(key) || !nodes.has(r.from_id) || !nodes.has(r.to_id)) continue;
    seen.add(key);
    edges.push({ source: r.from_id, target: r.to_id, type: r.type });
  }
  return { nodes: [...nodes.values()], edges };
}

/** A category filter dims everything outside its category; no filter dims nothing. */
export const isDimmed = (category: Category, filter: Category | null): boolean =>
  filter !== null && category !== filter;

export interface OrbitPoint {
  x: number;
  y: number;
  /** Dot radius. */
  r: number;
}

export const ORBIT_VIEWBOX = { width: 600, height: 540 } as const;

/** One tilted ellipse per category, innermost first; `phase` keeps dots of neighbouring rings apart. */
export const ORBIT_RINGS: readonly { category: Category; rx: number; ry: number; phase: number }[] =
  [
    { category: 'services', rx: 95, ry: 34, phase: 0.3 },
    { category: 'apps', rx: 155, ry: 56, phase: 1.1 },
    { category: 'data', rx: 210, ry: 76, phase: 0.6 },
    { category: 'infra', rx: 262, ry: 94, phase: 2.0 },
  ];

export const ORBIT_CENTER = { x: 300, y: 335 } as const;

/** Orbit positions: the members of a category are spread evenly around its ring, in sample order. */
export function orbitLayout(nodes: readonly EstateNode[]): Map<string, OrbitPoint> {
  const out = new Map<string, OrbitPoint>();
  for (const ring of ORBIT_RINGS) {
    const members = nodes.filter((n) => n.category === ring.category);
    const r = ring.category === 'services' ? 9 : members.length > 60 ? 3.5 : 6;
    members.forEach((n, i) => {
      const a = ring.phase + (i / members.length) * Math.PI * 2;
      out.set(n.id, {
        x: ORBIT_CENTER.x + Math.cos(a) * ring.rx,
        y: ORBIT_CENTER.y + Math.sin(a) * ring.ry,
        r,
      });
    });
  }
  return out;
}

export interface ErrorKind {
  kind: 'forbidden' | 'error';
  /** The server's own reason for a 403, otherwise the error message. */
  message: string;
}

/** Splits a refused read (403, with the server's reason) from every other failure. Duck-typed: no axios import. */
export function classifyError(error: unknown): ErrorKind {
  const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status === 403)
    return { kind: 'forbidden', message: forbiddenReason(response.data) };
  return { kind: 'error', message: error instanceof Error ? error.message : 'Request failed' };
}

/** A row of GET /itil/incidents (itil_incidents). `business_impact` defaults to zeros and nothing fills it yet. */
export interface IncidentRow {
  id: string;
  incident_number: string;
  title: string;
  /** 1 (highest) to 5. */
  priority: number;
  status: string;
  affected_ci_id: string | null;
  reported_at: string;
  business_impact?: { estimated_user_impact?: number; estimated_revenue_impact?: number } | null;
}

/** The statuses of an open incident; the list endpoint filters on one status at a time. */
export const OPEN_INCIDENT_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS'] as const;

/** The incident the ribbon leads with: highest priority (lowest number), then the most recently reported. */
export function leadIncident(rows: readonly IncidentRow[]): IncidentRow | null {
  let lead: IncidentRow | null = null;
  for (const r of rows) {
    if (
      !lead ||
      r.priority < lead.priority ||
      (r.priority === lead.priority && Date.parse(r.reported_at) > Date.parse(lead.reported_at))
    ) {
      lead = r;
    }
  }
  return lead;
}

/** "INC-" plus the first 8 characters when the number is the generated `INC-<uuid>`; any other number as is. */
export const shortIncidentNumber = (n: string): string =>
  /^INC-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(n) ? n.slice(0, 12) : n;

export function relativeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (!Number.isFinite(minutes)) return 'time unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

const usd = (n: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(n);

/**
 * The facts after the title. Users and revenue impact appear only when the incident carries a positive value: the
 * stored default is zero, which means "never estimated", not "no impact" (BW8), so a zero is never shown.
 */
export function incidentFacts(row: IncidentRow, now: number): string[] {
  const facts = [`P${row.priority}`, `opened ${relativeAge(row.reported_at, now)}`];
  const users = row.business_impact?.estimated_user_impact;
  const revenue = row.business_impact?.estimated_revenue_impact;
  if (typeof users === 'number' && users > 0)
    facts.push(`${users.toLocaleString('en-US')} users affected`);
  if (typeof revenue === 'number' && revenue > 0) facts.push(`${usd(revenue)} est. revenue impact`);
  return facts;
}
