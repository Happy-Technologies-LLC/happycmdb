// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v3-sample-data.cypher seeds :BusinessService nodes. TBM and dashboard reads
 * only count a :BusinessService node that carries the caller's organization
 * (FD-16 c), so every seeded service must be in the internal organization.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const SAMPLE_DATA = join(__dirname, '../v3-sample-data.cypher');

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

describe('packages/database/src/neo4j/v3-sample-data.cypher', () => {
  it('every seeded :BusinessService gets the internal org', () => {
    const all = statements();
    // Any MERGE/CREATE of a node pattern whose labels include BusinessService.
    const serviceVariable = (s: string): string | null => {
      for (const m of s.matchAll(/\b(?:MERGE|CREATE)\s*\((\w+)((?::\w+)+)/g)) {
        if (m[2]!.split(':').includes('BusinessService')) return m[1]!;
      }
      return null;
    };
    const seeded = all.flatMap(s => {
      const variable = serviceVariable(s);
      return variable === null ? [] : [{ variable, statement: s }];
    });
    expect(seeded).toHaveLength(5);

    // Each seed assigns the org exactly once, in its unconditional SET (not ON CREATE/ON MATCH,
    // which would leave an existing org-less sample service without an org on a re-run).
    const badSeeds = seeded
      .filter(({ variable, statement }) =>
        /\bON (CREATE|MATCH)\b/.test(statement) ||
        (statement.match(/organization_id/g) ?? []).length !== 1 ||
        !new RegExp(`^\\s*${variable}\\.organization_id = '${INTERNAL_ORG}',?$`, 'm').test(statement))
      .map(({ statement }) => statement.split('\n')[0]);
    expect(badSeeds).toEqual([]);

    // No other statement writes organization_id (relationships and other labels are untouched).
    const otherWriters = all
      .filter(s => s.includes('organization_id') && !seeded.some(({ statement }) => statement === s))
      .map(s => s.split('\n')[0]);
    expect(otherWriters).toEqual([]);
  });
});
