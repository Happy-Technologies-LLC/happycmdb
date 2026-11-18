// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2030: evidence-qualified edges. Currentness is DERIVED from receipt aggregates and the supplied database clock;
// these tables pin every rule of that derivation, the wire aggregate, and the guards of the evidence read.
const mockNeo4j = { getCIIncarnations: async (..._args: unknown[]): Promise<Map<string, string | null>> => new Map() };
const mockPostgres = { transaction: async (..._args: unknown[]): Promise<unknown> => ({ rows: [] }) };
const mockCalls: string[] = [];
jest.mock('@cmdb/database', () => ({
  CITraversalLimitError: class CITraversalLimitError extends Error {},
  getNeo4jClient: () => ({ getCIIncarnations: (...args: unknown[]) => { mockCalls.push('neo4j'); return mockNeo4j.getCIIncarnations(...args); } }),
  getPostgresClient: () => ({ transaction: (...args: unknown[]) => { mockCalls.push('postgres'); return mockPostgres.transaction(...args); } }),
}));

import { CITraversalLimitError } from '@cmdb/database';
import {
  EDGE_EVIDENCE_SCAN_CAP, EDGE_FRESHNESS_WINDOWS_DAYS, EVIDENCE_CLASS_ORDER, IMPACT_EVIDENCE_TIMEOUT_MS, MAX_EDGE_EVIDENCE_EDGES,
  deriveCurrentness, edgeKey, impactEvidenceTimeoutMs, loadEdgeEvidence, qualificationOf, qualifyEdges, summarizeEvidence,
  type EdgeQualification, type EvidenceClass, type EvidencePolarity, type EvidenceRow,
} from '../edge-evidence';
import { IMPACT_LINEAGE_TIMEOUT_MS, impactLineageTimeoutMs } from '../impact-envelope';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const READ_AT = new Date('2026-06-15T12:00:00.000Z');
/** An instant `ms` before the read. */
const before = (ms: number): Date => new Date(READ_AT.getTime() - ms);
const row = (evidence_class: EvidenceClass, polarity: EvidencePolarity, newest: Date | string, n = 1): EvidenceRow =>
  ({ evidence_class, polarity, n, newest });
const support = (cls: EvidenceClass, ms: number): EvidenceRow => row(cls, 'supports', before(ms));
const contradict = (cls: EvidenceClass, ms: number): EvidenceRow => row(cls, 'contradicts', before(ms));

describe('deriveCurrentness', () => {
  it('no scanned receipts is unsupported, never current or stale', () => {
    expect(deriveCurrentness([], READ_AT)).toBe('unsupported');
  });

  it.each<[string, string, EvidenceRow[]]>([
    ['fresh declared support', 'current', [support('declared', HOUR)]],
    ['declared support 179 days old', 'current', [support('declared', 179 * DAY)]],
    ['declared support 181 days old', 'stale', [support('declared', 181 * DAY)]],
    ['static_observed support 6 days old', 'current', [support('static_observed', 6 * DAY)]],
    ['static_observed support 8 days old', 'stale', [support('static_observed', 8 * DAY)]],
    ['runtime_observed support 23 hours old', 'current', [support('runtime_observed', 23 * HOUR)]],
    ['runtime_observed support 25 hours old', 'stale', [support('runtime_observed', 25 * HOUR)]],
  ])('%s is %s', (_name, expected, rows) => {
    expect(deriveCurrentness(rows, READ_AT)).toBe(expected);
  });

  describe('window boundary', () => {
    it.each<EvidenceClass>(['declared', 'static_observed', 'runtime_observed'])(
      '%s: the exact boundary instant is current (inclusive), one millisecond past it is stale', cls => {
        const window = EDGE_FRESHNESS_WINDOWS_DAYS[cls]! * DAY;
        expect(deriveCurrentness([support(cls, window)], READ_AT)).toBe('current');
        expect(deriveCurrentness([support(cls, window + 1)], READ_AT)).toBe('stale');
      });

    it('every class has its OWN window: 100 days is stale for static_observed and current for declared', () => {
      expect(deriveCurrentness([support('static_observed', 100 * DAY)], READ_AT)).toBe('stale');
      expect(deriveCurrentness([support('declared', 100 * DAY)], READ_AT)).toBe('current');
      expect(deriveCurrentness([support('runtime_observed', 2 * DAY)], READ_AT)).toBe('stale');
      expect(deriveCurrentness([support('declared', 2 * DAY)], READ_AT)).toBe('current');
    });

    it('is current when any one supporting class is inside its own window, even if another is outside', () => {
      expect(deriveCurrentness([support('declared', 181 * DAY), support('runtime_observed', HOUR)], READ_AT)).toBe('current');
      expect(deriveCurrentness([support('declared', 181 * DAY), support('static_observed', 100 * DAY)], READ_AT)).toBe('stale');
    });

    it('treats an observed_at after the read as inside the window', () => {
      expect(deriveCurrentness([row('runtime_observed', 'supports', new Date(READ_AT.getTime() + HOUR))], READ_AT)).toBe('current');
    });

    it('accepts an ISO string timestamp as pg returns it', () => {
      expect(deriveCurrentness([row('declared', 'supports', before(HOUR).toISOString())], READ_AT)).toBe('current');
      expect(deriveCurrentness([row('declared', 'supports', before(181 * DAY).toISOString())], READ_AT)).toBe('stale');
    });
  });

  describe('contradiction', () => {
    it('a support then a strictly newer contradiction is contradicted', () => {
      expect(deriveCurrentness([support('declared', 2 * HOUR), contradict('declared', HOUR)], READ_AT)).toBe('contradicted');
    });

    it('a contradiction then a strictly newer support is superseded: current', () => {
      expect(deriveCurrentness([contradict('declared', 2 * HOUR), support('declared', HOUR)], READ_AT)).toBe('current');
    });

    it('equal timestamps are contradicted', () => {
      expect(deriveCurrentness([support('declared', HOUR), contradict('declared', HOUR)], READ_AT)).toBe('contradicted');
    });

    it('a newer declared contradiction beats an older fresh static_observed support', () => {
      expect(deriveCurrentness([support('static_observed', 2 * HOUR), contradict('declared', HOUR)], READ_AT)).toBe('contradicted');
    });

    it('a newer support of another class supersedes an older contradiction', () => {
      expect(deriveCurrentness([contradict('declared', 2 * HOUR), support('static_observed', HOUR)], READ_AT)).toBe('current');
    });

    it('a contradiction alone is contradicted, however old', () => {
      expect(deriveCurrentness([contradict('declared', HOUR)], READ_AT)).toBe('contradicted');
      expect(deriveCurrentness([contradict('runtime_observed', 400 * DAY)], READ_AT)).toBe('contradicted');
    });

    it('an inferred support newer than a contradiction does NOT supersede it', () => {
      expect(deriveCurrentness([contradict('declared', 2 * HOUR), support('inferred', HOUR)], READ_AT)).toBe('contradicted');
      expect(deriveCurrentness([contradict('declared', 2 * HOUR), support('inferred', HOUR), support('declared', 3 * HOUR)], READ_AT))
        .toBe('contradicted');
    });

    it('an inferred contradiction counts as a contradiction', () => {
      expect(deriveCurrentness([support('declared', 2 * HOUR), contradict('inferred', HOUR)], READ_AT)).toBe('contradicted');
    });

    it('a superseded contradiction does not hide a stale support: the support still has to be inside its window', () => {
      expect(deriveCurrentness([contradict('declared', 300 * DAY), support('declared', 200 * DAY)], READ_AT)).toBe('stale');
    });
  });

  describe('inferred evidence', () => {
    it('inferred supports alone are stale, never current, however fresh', () => {
      expect(deriveCurrentness([support('inferred', 0)], READ_AT)).toBe('stale');
      expect(deriveCurrentness([support('inferred', 1)], READ_AT)).toBe('stale');
      expect(deriveCurrentness([row('inferred', 'supports', new Date(READ_AT.getTime() + DAY))], READ_AT)).toBe('stale');
    });

    it('fresh inferred support does not rescue a stale effective support', () => {
      expect(deriveCurrentness([support('inferred', HOUR), support('declared', 181 * DAY)], READ_AT)).toBe('stale');
    });
  });

  describe('clock', () => {
    afterEach(() => jest.useRealTimers());

    it('derives against the supplied readAt, not the process clock', () => {
      const rows = [support('declared', 10 * DAY)]; // 10 days old at READ_AT
      jest.useFakeTimers({ now: new Date('2099-01-01T00:00:00.000Z') }); // a far-future API clock would make it ancient
      expect(deriveCurrentness(rows, READ_AT)).toBe('current');
      jest.setSystemTime(new Date('1999-01-01T00:00:00.000Z')); // a far-past API clock would make a stale receipt look fresh
      expect(deriveCurrentness([support('declared', 181 * DAY)], READ_AT)).toBe('stale');
      expect(deriveCurrentness([support('runtime_observed', 2 * DAY)], READ_AT)).toBe('stale');
    });
  });
});

describe('summarizeEvidence', () => {
  const summary = (rows: EvidenceRow[], from = 'a', to = 'b', type = 'DEPENDS_ON') => summarizeEvidence(from, to, type, rows);

  it('lists classes in the fixed order, not alphabetical or insertion order', () => {
    const rows = [support('inferred', DAY), support('runtime_observed', DAY), support('static_observed', DAY), support('declared', DAY)];
    expect(summary(rows).classes).toEqual(['declared', 'static_observed', 'runtime_observed', 'inferred']);
    expect(summary([...rows].reverse()).classes).toEqual([...EVIDENCE_CLASS_ORDER]);
    expect(summary([support('runtime_observed', DAY), support('declared', DAY)]).classes).toEqual(['declared', 'runtime_observed']);
  });

  it('lists only classes with a SUPPORTING receipt', () => {
    expect(summary([contradict('declared', DAY), support('static_observed', DAY)]).classes).toEqual(['static_observed']);
    expect(summary([contradict('declared', DAY)]).classes).toEqual([]);
  });

  it('counts supports and contradicts across classes and sums them into receipt_count', () => {
    const evidence = summary([
      row('declared', 'supports', before(DAY), 3), row('static_observed', 'supports', before(DAY), 2),
      row('declared', 'contradicts', before(DAY), 4),
    ]);
    expect(evidence.support).toEqual({ supports: 5, contradicts: 4 });
    expect(evidence.receipt_count).toBe(9);
  });

  it('has no receipts: empty aggregate, null last_supported_at, not truncated', () => {
    const evidence = summary([]);
    expect(evidence).toMatchObject({
      classes: [], support: { supports: 0, contradicts: 0 }, receipt_count: 0, receipts_truncated: false, last_supported_at: null,
    });
  });

  it(`flags receipts_truncated exactly when the scan hit ${EDGE_EVIDENCE_SCAN_CAP}`, () => {
    expect(EDGE_EVIDENCE_SCAN_CAP).toBe(200);
    expect(summary([row('declared', 'supports', before(DAY), 199)]).receipts_truncated).toBe(false);
    expect(summary([row('declared', 'supports', before(DAY), 200)]).receipts_truncated).toBe(true);
    const split = summary([row('declared', 'supports', before(DAY), 150), row('declared', 'contradicts', before(DAY), 50)]);
    expect([split.receipt_count, split.receipts_truncated]).toEqual([200, true]);
    expect(summary([row('declared', 'supports', before(DAY), 150), row('declared', 'contradicts', before(DAY), 49)]).receipts_truncated).toBe(false);
  });

  it('reports last_supported_at as the ISO UTC instant of the newest supporting receipt of ANY class', () => {
    const newest = new Date('2026-06-14T10:30:15.250Z');
    const evidence = summary([
      row('declared', 'supports', new Date('2026-05-01T00:00:00.000Z')), row('inferred', 'supports', newest),
      row('runtime_observed', 'contradicts', new Date('2026-06-15T11:00:00.000Z')),
    ]);
    expect(evidence.last_supported_at).toBe('2026-06-14T10:30:15.250Z');
    expect(summary([row('declared', 'supports', '2026-06-14T10:30:15.250Z')]).last_supported_at).toBe('2026-06-14T10:30:15.250Z');
    expect(summary([contradict('declared', HOUR)]).last_supported_at).toBeNull();
  });

  it('carries exactly the coarse aggregate: no organization, incarnation, source or observer', () => {
    expect(Object.keys(summary([support('declared', DAY)])).sort()).toEqual(
      ['classes', 'last_supported_at', 'receipt_count', 'receipts_href', 'receipts_truncated', 'support'].sort());
  });

  it.each([
    ['plain ids', 'ci-1', 'ci-2', 'DEPENDS_ON'],
    ['reserved characters', 'a&b=c', 'd#e f', 'USES/ODD'],
    ['slashes and percent', 'org/ci/1', '100%25', 'T'],
    ['unicode and plus', 'ü+ñ', '日本', 'DEPENDS_ON'],
  ])('receipts_href round-trips %s through URLSearchParams', (_name, from, to, type) => {
    const href = summary([], from, to, type).receipts_href;
    const url = new URL(href, 'https://cmdb.invalid');
    expect(url.pathname).toBe('/api/v1/relationships/evidence');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()].sort()).toEqual(['from_id', 'to_id', 'type']);
    expect(url.searchParams.get('from_id')).toBe(from);
    expect(url.searchParams.get('to_id')).toBe(to);
    expect(url.searchParams.get('type')).toBe(type);
  });
});

describe('impactEvidenceTimeoutMs', () => {
  const evidence = (value?: string) => impactEvidenceTimeoutMs(value === undefined ? {} : { IMPACT_EVIDENCE_TIMEOUT_MS: value });

  it('honours a positive integer', () => {
    expect(evidence('750')).toBe(750);
  });

  it('accepts the int4 ceiling', () => {
    expect(evidence('2147483647')).toBe(2147483647);
  });

  it.each(['0', '-1', '-750', '1.5', '750.5', 'NaN', 'abc', '', ' ', '2147483648', '1e12', 'Infinity'])(
    'falls back to the 3000 default for %j', value => {
      expect(evidence(value)).toBe(IMPACT_EVIDENCE_TIMEOUT_MS);
      expect(IMPACT_EVIDENCE_TIMEOUT_MS).toBe(3000);
    });

  it('falls back to the default when unset', () => {
    expect(evidence()).toBe(3000);
  });

  it('is independent of the lineage knob, whose own behaviour is unchanged', () => {
    expect(impactEvidenceTimeoutMs({ IMPACT_LINEAGE_TIMEOUT_MS: '750' })).toBe(3000);
    expect(impactLineageTimeoutMs({ IMPACT_EVIDENCE_TIMEOUT_MS: '750' })).toBe(IMPACT_LINEAGE_TIMEOUT_MS);
    expect(impactLineageTimeoutMs({ IMPACT_LINEAGE_TIMEOUT_MS: '750' })).toBe(750);
    expect(impactLineageTimeoutMs({ IMPACT_LINEAGE_TIMEOUT_MS: '2147483647' })).toBe(2147483647);
    for (const value of ['0', '-1', '1.5', 'NaN', '', '2147483648']) {
      expect(impactLineageTimeoutMs({ IMPACT_LINEAGE_TIMEOUT_MS: value })).toBe(3000);
    }
    expect(impactLineageTimeoutMs({})).toBe(3000);
  });
});

describe('qualifyEdges', () => {
  const qualification = (type: string, from: string, to: string, rows: EvidenceRow[]): EdgeQualification =>
    ({ currentness: deriveCurrentness(rows, READ_AT), evidence: summarizeEvidence(from, to, type, rows) });
  const qualifiedOf = (entries: Array<[string, string, string, EvidenceRow[]]>) =>
    new Map(entries.map(([from, to, type, rows]) => [edgeKey(from, to, type), qualification(type, from, to, rows)]));

  it('deduplicates by (from,to,type) and sorts by from, to, then type', () => {
    const qualified = qualifiedOf([
      ['a', 'b', 'DEPENDS_ON', [support('declared', HOUR)]], ['a', 'b', 'USES', []], ['a', 'z', 'DEPENDS_ON', []], ['b', 'a', 'DEPENDS_ON', []],
    ]);
    const edges = qualifyEdges([
      { from: 'b', to: 'a', type: 'DEPENDS_ON' }, { from: 'a', to: 'z', type: 'DEPENDS_ON' }, { from: 'a', to: 'b', type: 'USES' },
      { from: 'a', to: 'b', type: 'DEPENDS_ON' }, { from: 'a', to: 'b', type: 'DEPENDS_ON' },
    ], qualified);
    expect(edges.map(edge => [edge.from, edge.to, edge.type])).toEqual([
      ['a', 'b', 'DEPENDS_ON'], ['a', 'b', 'USES'], ['a', 'z', 'DEPENDS_ON'], ['b', 'a', 'DEPENDS_ON'],
    ]);
  });

  it('keeps direction: A->B and B->A are two edges with their own qualification', () => {
    const qualified = qualifiedOf([
      ['A', 'B', 'DEPENDS_ON', [support('declared', HOUR)]], ['B', 'A', 'DEPENDS_ON', [contradict('declared', HOUR)]],
    ]);
    const edges = qualifyEdges([{ from: 'B', to: 'A', type: 'DEPENDS_ON' }, { from: 'A', to: 'B', type: 'DEPENDS_ON' }], qualified);
    expect(edges.map(edge => [edge.from, edge.to, edge.currentness])).toEqual([['A', 'B', 'current'], ['B', 'A', 'contradicted']]);
  });

  it('does not merge ids that only collide when concatenated', () => {
    const qualified = qualifiedOf([['a|b', 'c', 'T', []], ['a', 'b|c', 'T', []]]);
    expect(qualifyEdges([{ from: 'a|b', to: 'c', type: 'T' }, { from: 'a', to: 'b|c', type: 'T' }], qualified)).toHaveLength(2);
  });

  it('emits exactly from, to, type, currentness and evidence per edge', () => {
    const qualified = qualifiedOf([['a', 'b', 'T', [support('declared', HOUR)]]]);
    const [edge] = qualifyEdges([{ from: 'a', to: 'b', type: 'T' }], qualified);
    expect(Object.keys(edge!).sort()).toEqual(['currentness', 'evidence', 'from', 'to', 'type']);
    expect(edge).toMatchObject({ currentness: 'current', evidence: { support: { supports: 1, contradicts: 0 } } });
  });

  it('returns no edges for no edges', () => {
    expect(qualifyEdges([], new Map())).toEqual([]);
  });

  it('refuses an edge that was never loaded instead of inventing a currentness', () => {
    expect(() => qualifyEdges([{ from: 'a', to: 'b', type: 'T' }], new Map())).toThrow('Edge was not qualified');
    expect(() => qualificationOf(new Map(), 'a', 'b', 'T')).toThrow('Edge was not qualified');
  });
});

describe('loadEdgeEvidence guards', () => {
  const edgesOf = (count: number) => Array.from({ length: count }, (_, i) => ({ from: `from-${i}`, to: `to-${i}`, type: 'DEPENDS_ON' }));

  beforeEach(() => { mockCalls.length = 0; });

  it(`refuses more than ${MAX_EDGE_EVIDENCE_EDGES} edges with CITraversalLimitError before either store is touched`, async () => {
    await expect(loadEdgeEvidence('org', edgesOf(MAX_EDGE_EVIDENCE_EDGES + 1), { timeoutMs: 1000 })).rejects.toBeInstanceOf(CITraversalLimitError);
    expect(mockCalls).toEqual([]);
  });

  it('issues nothing at all for no edges', async () => {
    expect((await loadEdgeEvidence('org', [], { timeoutMs: 1000 })).size).toBe(0);
    expect(mockCalls).toEqual([]);
  });

  it('accepts exactly the maximum, and edges whose endpoints have no incarnation are unsupported without any PostgreSQL statement', async () => {
    mockNeo4j.getCIIncarnations = async () => new Map(); // no endpoint owned/known: nothing to fence receipts to
    const qualified = await loadEdgeEvidence('org', edgesOf(MAX_EDGE_EVIDENCE_EDGES), { timeoutMs: 1000 });
    expect(qualified.size).toBe(MAX_EDGE_EVIDENCE_EDGES);
    expect([...qualified.values()].every(item => item.currentness === 'unsupported' && item.evidence.receipt_count === 0)).toBe(true);
    expect(mockCalls).toEqual(['neo4j']);
  });
});
