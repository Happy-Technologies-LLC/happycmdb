// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1604 A3: SOURCE_OWNED_WRITE (database/src/neo4j/source-owned-grant.ts) is AISyncWriter's capability. Another
 * package cannot import it by the @cmdb/database package name: not under Node (package.json exports), not under a
 * NodeNext tsconfig (api-server's; no tsconfig path) and not under the root jest configs (moduleNameMapper). The
 * package entry point still resolves for tsc and jest. Packages on moduleResolution "node" and per-package jest
 * configs still map deep specifiers (follow-up).
 */
import { spawnSync } from 'child_process';
import { join } from 'path';
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
