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
  'identity-resolution/src/engine/identity-reconciliation-engine.ts': { count: 2, reason: 'create-if-missing path, reached only by non-API writers (HP1-S5)' },
  'etl-processor/src/jobs/reconciliation.job.ts': { count: 1, reason: 'ETL writer, journaled by HP1-S5 (A-12)' },
  'bsm-impact-engine/src/utils/graph-traversal.ts': { count: 1, reason: 'library with no deployable importer (asserted below)' },
  'itil-service-manager/src/repositories/ci-repository.ts': { count: 1, reason: 'library with no deployable importer (asserted below)' },
  'api-server/src/auth/neo4j-auth.repository.ts': { count: 6, reason: ':User/:ApiKey nodes, not :CI' },
  'api-server/src/auth/user-lock.ts': { count: 2, reason: ':User lock, not :CI' },
  'api-server/src/scripts/backfill-business-service-organization.ts': { count: 4, reason: 'operator script, :BusinessService' },
  'api-server/src/scripts/identity-window.ts': { count: 4, reason: 'operator script, :User (FD-5 adds the organization assignment)' },
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
      } else if (/\.[jt]s$/.test(name) && !/\.d\.ts$|\.(test|spec)\.[jt]s$/.test(name)) { // §10.4: committed .js too
        out.push({ file: relative(PACKAGES, path), text: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    if (statSync(join(PACKAGES, pkg)).isDirectory()) {
      try { walk(join(PACKAGES, pkg, 'src')); } catch { /* package without src */ }
    }
  }
  return out;
}

const all = sources();
// common holds Cypher/SQL validators whose strings name these keywords.
const files = all.filter(({ file }) => !file.startsWith('common/'));

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

it('E-7 g1 self-test: the scan matches every listed graph-write construct exactly once', () => {
  const constructs = ['SET ci.name = $n', 'SET ci += $props', 'SET ci = $props', 'DETACH DELETE ci', 'DELETE r', 'REMOVE ci.name',
    'CREATE (c:CI {id: $id})', 'MERGE (ci:CI {id: $id})', 'MERGE (a)-[r:DEPENDS_ON]->(b)', 'MATCH (ci:CI) RETURN ci'];
  expect(constructs.map(text => text.match(GRAPH_MUTATION)?.length ?? 0)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
});

// §10.4 gate 2: no CI write over HTTP from a deployable module (the 7bde921 discovery InternalAPIClient path).
const HTTP_CI_WRITE = /\bInternalAPIClient\b|internal-api-client|\b(?:axios|fetch|\w+\.(?:post|put|patch|delete|get|request))\s*\(\s*[`'"][^`'"]*\/api\/v1\/(?:cis|reconciliation)\b/;
it('E-7 g2: no module imports InternalAPIClient or calls axios/fetch with a /api/v1/cis or /reconciliation literal', () => {
  expect(all.filter(({ text }) => HTTP_CI_WRITE.test(text)).map(({ file }) => file)).toEqual([]);
  expect(["import { getInternalAPIClient } from '../api/internal-api-client';", 'private api: InternalAPIClient;',
    "await axios.post('/api/v1/cis', ci)", 'await fetch(`${base}/api/v1/reconciliation/merge`, init)',
    'this.client.put(`/api/v1/cis/${id}`, data)', "axios.get('/api/v1/relationships')", "const path = '/api/v1/cis';"]
    .map(text => HTTP_CI_WRITE.test(text))).toEqual([true, true, true, true, true, false, false]);
});

// §10.4 gate 3 / §10.5: every BullMQ registration is listed; all but the two primitives wrap codedProcessor.
const WORKER_SITE = /\bnew\s+(?:\w+\.)?Worker\s*(?:<[^>]*>)?\s*\(|\.registerWorker\s*\(/g;
const WORKERS: Record<string, { count: number; primitive?: true }> = {
  'common/src/queues/queue-manager.ts': { count: 1, primitive: true }, // registerWorker: its callers are listed below
  'database/src/bullmq/queue-manager.ts': { count: 1, primitive: true },
  'discovery-engine/src/orchestrator/discovery-orchestrator.ts': { count: 1 },
  'discovery-engine/src/workers/cost-sync.worker.ts': { count: 3 },
  'etl-processor/src/index.ts': { count: 4 },
  'etl-processor/src/workers/v3-etl.worker.ts': { count: 3 },
  'tbm-cost-engine/src/integrations/cost-sync.service.ts': { count: 1 },
};
/** Sites whose processor argument is neither a codedProcessor(...) call nor a local bound to one. */
const unwrapped = (text: string) => [...text.matchAll(WORKER_SITE)].filter(site => {
  const arg = /^\s*[^,()]+,\s*(?:(?:\(0,\s*)?(?:\w+\.)?codedProcessor\)?\s*[<(]|(\w+)\s*[,)])/.exec(text.slice(site.index! + site[0].length));
  return !arg || (arg[1] !== undefined && !new RegExp(`\\b${arg[1]}\\s*=\\s*codedProcessor\\b`).test(text));
}).length;
it('E-7 g3: an unlisted or unwrapped Worker/registerWorker site fails', () => {
  const found: Record<string, number> = {};
  const bare: string[] = [];
  for (const { file, text } of all) {
    const count = text.match(WORKER_SITE)?.length ?? 0;
    if (count) found[file] = count;
    if (count && !WORKERS[file]?.primitive && unwrapped(text)) bare.push(file);
  }
  expect([found, bare]).toEqual([Object.fromEntries(Object.entries(WORKERS).map(([file, { count }]) => [file, count])), []]);
  expect(["new Worker('q', async job => job.data)", "queueManager.registerWorker('q', handler)",
    "const handler = codedProcessor('q', s, fn); queueManager.registerWorker(q, handler, {})",
    "new bullmq_1.Worker(names.Q, (0, common_1.codedProcessor)('q', {}, fn))", "new Worker<T, R>('q', codedProcessor('q', s, fn))"]
    .map(unwrapped)).toEqual([1, 1, 0, 0, 0]);
});
