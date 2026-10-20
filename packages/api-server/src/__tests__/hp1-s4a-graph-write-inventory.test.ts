// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HP1 v16 I5/I6, §10.4 inventory gate (E-7 subset owned by S4a, F8): every
// deployable graph mutation is a journaled W or a named residual; history is
// inserted only by the journal's T2; no module outside the journal touches the
// :ReconciliationOp fence. Adding an unjournaled `SET ci.x` anywhere fails here.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const PACKAGES = join(__dirname, '../../..');
const GRAPH_MUTATION = /\bSET\s+\w+\.\w+|\bSET\s+\w+\s*\+=|\bSET\s+\w+\s*=\s*\$[A-Za-z]|\bDETACH\s+DELETE\b|\bDELETE\s+(?!FROM\b)[a-z]\w*\b|\bREMOVE\s+\w+\.|\b(?:CREATE|MERGE)\s*\(\s*\w*\s*:\s*CI\b|\bMERGE\s*\(\s*\w+\s*\)\s*-\s*\[/g;
const LIBRARY_ONLY = ['bsm-impact-engine', 'itil-service-manager', 'framework-integration'];

// Exact per-file counts: a new mutation in a listed file fails too.
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'database/src/journal/journal.ts': { count: 10, reason: 'the journaled W statements and the recovery fence' },
  'database/src/neo4j/client.ts': { count: 2, reason: 'legacyCreateCIUnjournaled (HP1-S5 ETL residual) and the incarnation marker' },
  'identity-resolution/src/engine/identity-reconciliation-engine.ts': { count: 3, reason: 'merge writer, journaled by HP1-S4b' },
  'etl-processor/src/jobs/reconciliation.job.ts': { count: 1, reason: 'ETL writer, journaled by HP1-S5 (A-12)' },
  'bsm-impact-engine/src/utils/graph-traversal.ts': { count: 1, reason: 'library with no deployable importer (asserted below)' },
  'itil-service-manager/src/repositories/ci-repository.ts': { count: 1, reason: 'library with no deployable importer (asserted below)' },
  'api-server/src/auth/neo4j-auth.repository.ts': { count: 6, reason: ':User/:ApiKey nodes, not :CI' },
  'api-server/src/auth/user-lock.ts': { count: 2, reason: ':User lock, not :CI' },
  'api-server/src/scripts/backfill-business-service-organization.ts': { count: 4, reason: 'operator script, :BusinessService' },
  'api-server/src/scripts/identity-window.ts': { count: 3, reason: 'operator script, :User' },
  'api-server/src/scripts/rotate-user-password.ts': { count: 2, reason: 'operator script, :User' },
  'api-server/src/scripts/seed-tenant-fixture.ts': { count: 1, reason: 'operator script, :User' },
};

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!['node_modules', 'dist', '__tests__'].includes(name)) walk(path);
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
        out.push({ file: relative(PACKAGES, path), text: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    // common holds Cypher/SQL validators whose strings name these keywords.
    if (pkg !== 'common' && statSync(join(PACKAGES, pkg)).isDirectory()) {
      try { walk(join(PACKAGES, pkg, 'src')); } catch { /* package without src */ }
    }
  }
  return out;
}

const files = sources();

it('allows graph mutations only in the journal and named residuals', () => {
  const found: Record<string, number> = {};
  for (const { file, text } of files) {
    const count = text.match(GRAPH_MUTATION)?.length ?? 0;
    if (count) found[file] = count;
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count])));
});

it('inserts history and touches the fence only from the journal', () => {
  const writers = files.filter(({ text }) => /INSERT\s+INTO\s+ci_change_history|ReconciliationOp\b/.test(text));
  expect(writers.map(({ file }) => file)).toEqual(['database/src/journal/journal.ts']);
});

it('keeps the residual library writers unreachable from deployable packages', () => {
  const importers = files.filter(({ file, text }) => !LIBRARY_ONLY.some(pkg => file.startsWith(`${pkg}/`)) &&
    LIBRARY_ONLY.some(pkg => text.includes(`@cmdb/${pkg}`)));
  expect(importers.map(({ file }) => file)).toEqual([]);
});
