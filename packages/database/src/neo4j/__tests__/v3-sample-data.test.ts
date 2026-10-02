// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v3-sample-data.cypher seeds :BusinessService nodes. TBM and dashboard reads
 * only count a :BusinessService node that carries the caller's organization
 * (FD-16 c), so every seeded service must be in the internal organization, and
 * a reseed must never take over a node another organization already owns.
 *
 * The script's :BusinessService statements are evaluated, as cypher-shell -f
 * would run them, over an in-memory graph that applies exactly the guards each
 * statement contains (a MERGE followed by an unguarded SET overwrites whatever
 * node has the id, as Neo4j would). A :BusinessService statement of any other
 * shape fails the test instead of being skipped.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const SAMPLE_DATA = join(__dirname, '../v3-sample-data.cypher');
const SAMPLE_IDS = [
  'bs-ecommerce-platform', 'bs-customer-support', 'bs-inventory-management', 'bs-payment-processing', 'bs-analytics-reporting',
];

/** Statements as cypher-shell reads them: comment lines dropped, split on ';' outside '…' literals. */
function statements(): string[] {
  const script = readFileSync(SAMPLE_DATA, 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  const out: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "'" && script[i - 1] !== '\\') inString = !inString;
    if (ch === ';' && !inString) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out.filter(s => s.length > 0);
}

type Props = Record<string, string>;
/**
 * services: :BusinessService nodes. cis: :CI nodes that differ from the
 * init-neo4j.cypher seed, which puts every sample CI in the internal org.
 */
interface Graph { services: Map<string, Props>; cis: Map<string, Props>; edges: Set<string> }

const SEED_RE =
  /^MERGE \((\w+):BusinessService \{id: '([^']+)'\}\)\s+(?:WITH (\w+) WHERE coalesce\((\w+)\.organization_id, '([^']+)'\) = '([^']+)'\s+)?SET ([\s\S]+)$/;
const ASSIGNMENT_RE = /^(\w+)\.(\w+) = ('[^']*'|datetime\(\))$/;
const MATCH_RE = /MATCH \((\w+):([\w:]+) \{id: '([^']+)'\}\)(?: WHERE (\w+)\.organization_id = '([^']+)')?/g;
const EDGE_RE = /MERGE \((\w+)\)-\[:(\w+) \{[^}]*\}\]->\((\w+)\)$/;

/** Applies one :BusinessService or sample-CI statement of the script to the graph. */
function apply(graph: Graph, statement: string): void {
  const seed = statement.match(SEED_RE);
  if (seed) {
    const [, variable, id, withVariable, guardVariable, fallback, expected, sets] = seed;
    const node = graph.services.get(id!) ?? { id: id! };
    graph.services.set(id!, node);
    if (withVariable !== undefined) {
      if (withVariable !== variable || guardVariable !== variable) throw new Error(`unmodelled guard: ${statement}`);
      if ((node['organization_id'] ?? fallback) !== expected) return;
    }
    // Assignments are separated by commas outside '…' literals; quoted values never contain a quote.
    const assignments: string[] = [''];
    let quoted = false;
    for (const ch of sets!) {
      if (ch === "'") quoted = !quoted;
      if (ch === ',' && !quoted) assignments.push('');
      else assignments[assignments.length - 1] += ch;
    }
    for (const assignment of assignments) {
      const parsed = assignment.trim().match(ASSIGNMENT_RE);
      if (!parsed || parsed[1] !== variable) throw new Error(`unmodelled SET: ${assignment}`);
      node[parsed[2]!] = parsed[3] === 'datetime()' ? 'datetime()' : parsed[3]!.slice(1, -1);
    }
    return;
  }

  const flat = statement.replace(/\s+/g, ' ');
  const edge = flat.match(EDGE_RE);
  const matches = [...flat.matchAll(MATCH_RE)];
  if (edge && matches.length === 2 && flat === `${matches.map(m => m[0]).join(' ')} ${edge[0]}`) {
    const ids: Record<string, string> = {};
    for (const [, variable, labels, id, whereVariable, organizationId] of matches) {
      if (labels!.split(':').includes('BusinessService')) {
        const node = graph.services.get(id!);
        if (node === undefined) return;
        if (whereVariable !== undefined && (whereVariable !== variable || node['organization_id'] !== organizationId)) return;
      } else if (labels!.split(':').includes('CI')) {
        const node = graph.cis.get(id!) ?? { id: id!, organization_id: INTERNAL_ORG };
        if (whereVariable !== undefined && (whereVariable !== variable || node['organization_id'] !== organizationId)) return;
      } else if (whereVariable !== undefined) {
        throw new Error(`unmodelled WHERE: ${statement}`);
      }
      ids[variable!] = id!;
    }
    graph.edges.add(`${ids[edge[1]!]} -${edge[2]}-> ${ids[edge[3]!]}`);
    return;
  }

  throw new Error(`unmodelled statement: ${statement.split('\n')[0]}`);
}

/** Runs every :BusinessService and :CI statement of the script (the trailing read-only count excepted). */
function seed(graph: Graph): void {
  for (const statement of statements()) {
    if (!/BusinessService|:CI\b/.test(statement) || statement.startsWith('MATCH (bs:BusinessService) WITH count(bs)')) continue;
    apply(graph, statement);
  }
}

const snapshot = (graph: Graph) => JSON.stringify({ services: [...graph.services].sort(), edges: [...graph.edges].sort() });

describe('packages/database/src/neo4j/v3-sample-data.cypher', () => {
  it('every seeded :BusinessService gets the internal org', () => {
    // bs-payment-processing exists from a pre-tenancy seed, without an organization.
    const graph: Graph = {
      services: new Map([['bs-payment-processing', { id: 'bs-payment-processing' }]]), cis: new Map(), edges: new Set(),
    };

    seed(graph);

    expect([...graph.services.keys()].sort()).toEqual([...SAMPLE_IDS].sort());
    for (const id of SAMPLE_IDS) {
      expect([id, graph.services.get(id)!['organization_id']]).toEqual([id, INTERNAL_ORG]);
    }
    // 6 ENABLES, 5 DELIVERS, 3 RUNS_ON, 4 SUPPORTS.
    expect(graph.edges.size).toBe(18);
  });

  it("reseeding keeps another organization's node with a sample id, and is idempotent", () => {
    // Org A already owns a node whose id is a sample id (for example after the backfill).
    const tenantNode = { id: 'bs-ecommerce-platform', organization_id: ORG_A, name: 'A Storefront' };
    const graph: Graph = { services: new Map([['bs-ecommerce-platform', { ...tenantNode }]]), cis: new Map(), edges: new Set() };

    seed(graph);
    const first = snapshot(graph);
    seed(graph);

    expect(snapshot(graph)).toBe(first);
    // Org A's node keeps its organization and properties, and no sample CI or app is attached to it.
    expect(graph.services.get('bs-ecommerce-platform')).toEqual(tenantNode);
    expect([...graph.edges].filter(edge => edge.includes('bs-ecommerce-platform'))).toEqual([]);
    // The other samples are seeded into the internal org as usual.
    for (const id of SAMPLE_IDS.filter(sample => sample !== 'bs-ecommerce-platform')) {
      expect([id, graph.services.get(id)!['organization_id']]).toEqual([id, INTERNAL_ORG]);
    }
    expect(graph.edges).toContain('as-payment-gateway -ENABLES-> bs-payment-processing');
  });

  it("reseeding attaches no sample edge to another organization's CI with a sample id", () => {
    // Org A owns CIs whose ids are sample CI ids (the sample CIs were never seeded or were deleted).
    const tenantCIs = ['srv-prod-api-01', 'db-postgres-datamart'];
    const graph: Graph = {
      services: new Map(),
      cis: new Map(tenantCIs.map(id => [id, { id, organization_id: ORG_A }])),
      edges: new Set(),
    };

    seed(graph);

    expect([...graph.edges].filter(edge => tenantCIs.some(id => edge.includes(id)))).toEqual([]);
    // Internal sample CIs are still linked.
    expect(graph.edges).toContain('as-web-frontend -RUNS_ON-> srv-prod-web-01');
    expect(graph.edges).toContain('db-neo4j-prod -SUPPORTS-> bs-ecommerce-platform');
  });
});
