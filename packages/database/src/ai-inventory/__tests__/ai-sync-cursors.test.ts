// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1608 D(1): every statement on ai_sync_cursors is organization-scoped (PGlite, migration 047 applied).
import { fork } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { AISyncCursors } from '../ai-sync-cursors';

const PACKAGES = join(__dirname, '../../../..');
const host = fork(join(PACKAGES, 'api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<{ rows: Record<string, unknown>[] }>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, unknown>[]; error?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(new Error(error));
  else call.resolve({ rows });
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const call = Promise.withResolvers<{ rows: Record<string, unknown>[] }>();
  pending.set(serial, call);
  host.send({ id: serial++, op, sql: text, params });
  return call.promise;
}
const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

beforeAll(async () => {
  const migration = readFileSync(join(__dirname, '../../postgres/migrations/047_ai_sync_cursors.sql'), 'utf8');
  await sql(`BEGIN;\n${migration}\nCOMMIT;`, [], 'exec');
}, 30000);
afterAll(() => host.kill());

it('tenant A cannot read or advance tenant B\'s cursor', async () => {
  const cursors = new AISyncCursors({ query: sql });
  const asOfB = new Date('2026-11-01T00:00:00Z');
  await cursors.advance(B, 'c4_releases', 'b-1', asOfB);
  expect(await cursors.read(A, 'c4_releases')).toBeNull();
  await cursors.advance(A, 'c4_releases', 'a-1', new Date('2026-11-02T00:00:00Z'));
  await cursors.advance(A, 'c4_releases', 'a-2', new Date('2026-11-03T00:00:00Z'));
  expect([await cursors.read(A, 'c4_releases'), await cursors.read(B, 'c4_releases')]).toEqual([
    expect.objectContaining({ cursor: 'a-2', asOf: new Date('2026-11-03T00:00:00Z'), lastErrorCode: null }),
    expect.objectContaining({ cursor: 'b-1', asOf: asOfB })]);
});

it('no other product source has SQL on ai_sync_cursors', () => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '__tests__', 'migrations'].includes(entry.name)) walk(path);
      } else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.(test|spec)\.[jt]s$/.test(entry.name) &&
        /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:public\.)?ai_sync_cursors\b/i.test(readFileSync(path, 'utf8'))) {
        found.push(relative(PACKAGES, path));
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (pkg.isDirectory()) try { walk(join(PACKAGES, pkg.name, 'src')); } catch { /* package without src */ }
  }
  expect(found).toEqual(['database/src/ai-inventory/ai-sync-cursors.ts']);
});
