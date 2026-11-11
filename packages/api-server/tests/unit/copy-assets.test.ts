// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-900: the build must put openapi.yaml where the compiled swagger.routes.js
 * looks for it (dist/rest/routes/../../openapi/openapi.yaml = dist/openapi/openapi.yaml).
 * Runs the real build step against a scratch package root and loads the result
 * with the same loader and relative path swagger.routes.ts uses.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yamljs';

const script = join(__dirname, '../../scripts/copy-assets.cjs');
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hap900-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('copy-assets build step', () => {
  it('makes the spec loadable from the compiled swagger.routes location', () => {
    mkdirSync(join(root, 'src/openapi'), { recursive: true });
    writeFileSync(
      join(root, 'src/openapi/openapi.yaml'),
      'openapi: 3.0.0\ninfo:\n  title: t\n  version: 9.9.9\npaths:\n  /x: {}\n'
    );

    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    expect(run.status).toBe(0);

    const compiledRoutesDir = join(root, 'dist/rest/routes');
    const doc = YAML.load(join(compiledRoutesDir, '../../openapi/openapi.yaml'));
    expect(doc.info.version).toBe('9.9.9');
    expect(Object.keys(doc.paths)).toEqual(['/x']);
  });

  it('fails the build when the source spec is missing', () => {
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
  });
});
