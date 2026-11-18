// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2032: the measurement fixture is only a valid answer key while its expected currentness is what the real derivation
// returns. This test binds the fixture to `deriveCurrentness`, so a change to the rules or windows fails here instead of
// silently invalidating a measurement run.
jest.mock('@cmdb/database', () => ({
  CITraversalLimitError: class CITraversalLimitError extends Error {},
  getNeo4jClient: () => ({ getCIIncarnations: async () => new Map() }),
  getPostgresClient: () => ({ transaction: async () => ({ rows: [] }) }),
}));

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { deriveCurrentness, type EvidenceRow } from '../edge-evidence';

interface FixtureEdge {
  id: string;
  case: string;
  from: string;
  to: string;
  type: string;
  rows: EvidenceRow[];
  expectedCurrentness: string;
}
interface Fixture {
  fixtureVersion: string;
  readAt: string;
  targetCi: string;
  edges: FixtureEdge[];
  beyondGraph: string[];
  answerKey: {
    falseComplete: { declaredGraphIsCompleteRuntimeBlastRadius: boolean };
    missedDependency: { mustName: string[] };
    wronglyTrustedEdge: { notCurrentEdges: string[] };
    wronglyDiscardedEdge: { currentEdges: string[] };
  };
}

const FIXTURE_PATH = resolve(__dirname, '../routes/__tests__/fixtures/impact-assessment-measurement.json');
const load = (): Fixture => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

const sortedKeys = (value: object): string[] => Object.keys(value).sort();
const READABLE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

describe('impact-assessment measurement fixture', () => {
  const fixture = load();

  it.each(fixture.edges.map(edge => [edge.id, edge] as const))(
    '%s: deriveCurrentness at readAt equals expectedCurrentness', (_id, edge) => {
      expect(deriveCurrentness(edge.rows, new Date(fixture.readAt))).toBe(edge.expectedCurrentness);
    });

  it('covers all four currentness values', () => {
    const seen = new Set(fixture.edges.map(edge => deriveCurrentness(edge.rows, new Date(fixture.readAt))));
    expect([...seen].sort()).toEqual(['contradicted', 'current', 'stale', 'unsupported']);
  });

  it('beyondGraph CIs are truly impacted but appear in no recorded edge', () => {
    expect(fixture.beyondGraph.length).toBeGreaterThan(0);
    const inEdges = new Set(fixture.edges.flatMap(edge => [edge.from, edge.to]));
    for (const id of fixture.beyondGraph) {
      expect(inEdges.has(id)).toBe(false);
    }
    expect(inEdges.has(fixture.targetCi)).toBe(true);
  });

  it('the answer key agrees with the derived currentness and with beyondGraph', () => {
    const readAt = new Date(fixture.readAt);
    const derived = (current: boolean): string[] =>
      fixture.edges.filter(edge => (deriveCurrentness(edge.rows, readAt) === 'current') === current).map(edge => edge.id);
    expect(fixture.answerKey.falseComplete.declaredGraphIsCompleteRuntimeBlastRadius).toBe(false);
    expect([...fixture.answerKey.missedDependency.mustName].sort()).toEqual([...fixture.beyondGraph].sort());
    expect([...fixture.answerKey.wronglyTrustedEdge.notCurrentEdges].sort()).toEqual(derived(false).sort());
    expect([...fixture.answerKey.wronglyDiscardedEdge.currentEdges].sort()).toEqual(derived(true).sort());
  });

  it('is disposable: fixed keys only, readable ids, no organization, token, email or host name', () => {
    expect(sortedKeys(fixture)).toEqual(['answerKey', 'beyondGraph', 'edges', 'fixtureVersion', 'readAt', 'targetCi']);
    expect(sortedKeys(fixture.answerKey)).toEqual(['falseComplete', 'missedDependency', 'wronglyDiscardedEdge', 'wronglyTrustedEdge']);
    const ids: string[] = [fixture.targetCi, ...fixture.beyondGraph];
    for (const edge of fixture.edges) {
      expect(sortedKeys(edge)).toEqual(['case', 'expectedCurrentness', 'from', 'id', 'rows', 'to', 'type']);
      expect(edge.type).toBe('DEPENDS_ON');
      ids.push(edge.id, edge.case, edge.from, edge.to);
      for (const row of edge.rows) {
        expect(sortedKeys(row)).toEqual(['evidence_class', 'n', 'newest', 'polarity']);
        expect(new Date(row.newest as string).toISOString()).toBe(row.newest);
      }
    }
    ids.push(...fixture.answerKey.missedDependency.mustName, ...fixture.answerKey.wronglyTrustedEdge.notCurrentEdges,
      ...fixture.answerKey.wronglyDiscardedEdge.currentEdges);
    for (const id of ids) {
      expect(id).toMatch(READABLE_ID);
    }
    expect(new Date(fixture.readAt).toISOString()).toBe(fixture.readAt);
  });
});
