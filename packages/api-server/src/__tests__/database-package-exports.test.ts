// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1604 A3: SOURCE_OWNED_WRITE (database/src/neo4j/source-owned-grant.ts) is AISyncWriter's capability. Another
 * package cannot import it by the @cmdb/database package name: not under Node (package.json exports), not under a
 * NodeNext tsconfig (api-server's; no tsconfig path) and not under the root jest configs (moduleNameMapper). The
 * package entry point still resolves for tsc and jest.
 * HAP-1608 B: an exports map cannot stop a relative path, a moduleResolution "node" tsconfig or a per-package jest
 * mapper, so a source gate (hp1-s4a style) refuses any string naming the grant module outside packages/database/src,
 * and no jest config may map a specifier onto the grant file.
 */
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import * as ts from 'typescript';

const API_SERVER = join(__dirname, '../..');
const GRANT = ['neo4j/source-owned-grant', 'src/neo4j/source-owned-grant', 'dist/neo4j/source-owned-grant']
  .map(path => `@cmdb/database/${path}`);

it('jest resolves @cmdb/database but not the grant module by package name', () => {
  expect(() => require.resolve('@cmdb/database')).not.toThrow();
  for (const specifier of GRANT) expect(() => require.resolve(specifier)).toThrow();
});

it('tsc (api-server tsconfig) resolves @cmdb/database but not the grant module by package name', () => {
  const config = ts.getParsedCommandLineOfConfigFile(join(API_SERVER, 'tsconfig.json'), {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
  const resolve = (specifier: string) =>
    ts.resolveModuleName(specifier, join(API_SERVER, 'src/index.ts'), config.options, ts.sys).resolvedModule;
  expect(resolve('@cmdb/database')).toBeDefined();
  expect(GRANT.map(resolve)).toEqual(GRANT.map(() => undefined));
});

it('Node refuses every deep @cmdb/database specifier as not exported', () => {
  const probe = `for (const s of ${JSON.stringify(GRANT)}) { try { require.resolve(s); console.log('resolved'); }
    catch (e) { console.log(e.code); } }`;
  const run = spawnSync(process.execPath, ['-e', probe], { cwd: API_SERVER, encoding: 'utf8' });
  expect(run.stdout.trim().split('\n')).toEqual(GRANT.map(() => 'ERR_PACKAGE_PATH_NOT_EXPORTED'));
});

const REPO = join(API_SERVER, '../..');
const DATABASE_SRC = join(REPO, 'packages/database/src');
/** A string literal naming the grant module: an import, require, jest.mock or moduleNameMapper target, any path style. */
const NAMES_GRANT = /(['"`])[^'"`\n]*source-owned-grant[^'"`\n]*\1/;
const GRANT_FILES = ['src', 'dist'].flatMap(dir => ['.ts', '.js'].map(ext =>
  join(REPO, 'packages/database', dir, `neo4j/source-owned-grant${ext}`)));
// Out of HAP-1608 scope (the package belongs to another lane): its `^@cmdb/database(.*)$` mapper still reaches the grant.
const MAPPER_RESIDUALS = ['packages/discovery-engine/jest.config.js'];

/** Every source, config and JSON file in the repository, without dependencies, build output or dot directories. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) walk(path, out);
    } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}
const repoFiles = walk(REPO);
const naming = repoFiles.filter(file => NAMES_GRANT.test(readFileSync(file, 'utf8')));

it('HAP-1608 B: only AISyncWriter and Neo4jClient name the grant module; nothing outside packages/database/src does', () => {
  expect(naming.filter(file => !file.startsWith(`${DATABASE_SRC}/`) && file !== __filename)
    .map(file => relative(REPO, file))).toEqual([]);
  // No other database module (the index above all) may import it and hand it on.
  expect(naming.filter(file => file.startsWith(`${DATABASE_SRC}/`) && !/__tests__/.test(file) && !GRANT_FILES.includes(file))
    .map(file => relative(DATABASE_SRC, file)).sort()).toEqual(['ai-inventory/ai-sync-writer.ts', 'neo4j/client.ts']);
});

it('HAP-1608 B: no jest moduleNameMapper (root or per-package) maps a specifier onto the grant module', () => {
  const reaching = new Set<string>();
  for (const file of repoFiles) {
    const name = file.slice(dirname(file).length + 1);
    let config: { moduleNameMapper?: Record<string, string | string[]> } | undefined;
    if (/^jest\.config(?:\.[\w-]+)?\.c?js$/.test(name)) config = require(file);
    else if (name === 'package.json') config = JSON.parse(readFileSync(file, 'utf8')).jest;
    for (const [pattern, targets] of Object.entries(config?.moduleNameMapper ?? {})) {
      for (const specifier of GRANT) {
        const match = new RegExp(pattern).exec(specifier);
        const mapped = match ? [targets].flat().map(target => join(target.replace(/<rootDir>/g, dirname(file))
          .replace(/\$(\d+)/g, (_, n: string) => match[Number(n)] ?? ''))) : [];
        if (mapped.some(path => GRANT_FILES.some(grant => ['', '.ts', '.js'].some(ext => path + ext === grant)))) {
          reaching.add(relative(REPO, file));
        }
      }
    }
  }
  expect([...reaching].sort()).toEqual(MAPPER_RESIDUALS);
});
